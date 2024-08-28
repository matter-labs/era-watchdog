use std::convert::TryFrom;
use std::{env, time};

use dotenv::dotenv;
use ethers::{prelude::*, types::transaction::eip2718::TypedTransaction};
use eyre::Result;
use metrics::{gauge, increment_counter};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const TX_PERIOD_SEC: u64 = 300;
const WAIT_FOR_RECEIPT_TIMEOUT_SEC: u64 = 30;
const SEND_ATTEMPTS: usize = 10;
const GAS_SCALE_FACTOR: u32 = 2;

pub fn run_prometheus_exporter() -> JoinHandle<()> {
    let builder = {
        let addr = ([0, 0, 0, 0], 8080);
        PrometheusBuilder::new().with_http_listener(addr)
    };

    let (recorder, exporter) = builder
        .build()
        .expect("failed to install Prometheus recorder");

    metrics::set_boxed_recorder(Box::new(recorder)).expect("failed to set the metrics recorder");

    tokio::spawn(async move {
        tokio::pin!(exporter);
        loop {
            tokio::select! {
                _ = &mut exporter => {}
            }
        }
    })
}

async fn try_submit_and_wait(
    signer: &SignerMiddleware<Provider<Http>, LocalWallet>,
    gas_price: U256,
    nonce: U256,
) -> Option<TransactionReceipt> {
    // Sending 1 wei to ourselves
    let tx = TransactionRequest::pay(signer.address(), 1 as u64)
        .gas_price(gas_price)
        .nonce(nonce);

    // Created to fit the expected type for estimate_gas function
    let legacy_tx = TypedTransaction::Legacy(tx.clone().into());

    // Estimate gas
    let estimate_gas_start = time::Instant::now();
    let gas_estimation = signer
        .estimate_gas(&legacy_tx, None)
        .await
        .expect("failed to get a gas estimate from the CHAIN_RPC_URL")
        .as_u64();

    info!("received a gas estimate from the CHAIN_RPC_URL");
    gauge!("watchdog.tx.gas", gas_estimation as f64, "type" => "gas_estimate");
    gauge!(
        "watchdog.tx.latency",
        estimate_gas_start.elapsed(),
        "stage" => "estimate_gas",
    );

    // Send the transaction
    let send_transaction_start = time::Instant::now();
    let pending_tx = match signer.send_transaction(tx, None).await {
        Ok(pending_tx) => {
            info!(
                "sending to the mempool completed for tx {:?}",
                pending_tx.tx_hash()
            );
            gauge!("watchdog.tx.send_status", 1.0);
            gauge!("watchdog.tx.latency", send_transaction_start.elapsed(), "stage" => "send_transaction");
            pending_tx
        }
        Err(err) => {
            warn!("failed to send transaction: {:?}", err);
            gauge!("watchdog.tx.send_status", 0.0);

            return None;
        }
    };

    // Wait for the transaction to be mined and get the receipt
    let confirmation_start = time::Instant::now();
    let wait_for_receipt = tokio::time::timeout(
        Duration::from_secs(WAIT_FOR_RECEIPT_TIMEOUT_SEC),
        pending_tx
            .confirmations(0)
            .interval(Duration::from_millis(100)),
    );
    match wait_for_receipt.await {
        Err(_) => {
            warn!("tx wasn't included in block");
            None
        }
        Ok(Ok(receipt)) => {
            gauge!("watchdog.tx.latency", confirmation_start.elapsed(), "stage" => "mempool");
            Some(receipt.unwrap())
        }
        Ok(Err(err)) => {
            warn!("failed to get transaction receipt: {:?}", err);
            None
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env variables
    dotenv().ok();

    tracing_subscriber::registry()
        .with(fmt::Layer::default())
        .with(EnvFilter::from_default_env())
        .init();

    // Start the prometheus exporter server
    run_prometheus_exporter();

    let pk = env::var("WALLET_KEY").expect("couldn't read environment variable WALLET_KEY");
    let chain_rpc_url =
        env::var("CHAIN_RPC_URL").expect("couldn't read environment variable CHAIN_RPC_URL");

    // Connect to the network
    let provider = Provider::<Http>::try_from(chain_rpc_url).expect("failed to create provider");

    let chain_id = provider
        .get_chainid()
        .await
        .expect("failed to get the chain id from provider");

    // Create the wallet from the private key
    let wallet: LocalWallet = pk.parse::<LocalWallet>()?.with_chain_id(chain_id.as_u64());

    // Connect the wallet to the provider
    let signer = SignerMiddleware::new(provider, wallet);

    loop {
        let mut gas_price = signer
            .get_gas_price()
            .await
            .expect("failed to fetch gas price");
        gauge!("gas_price", gas_price.as_u64() as f64);

        let nonce = signer
            .get_transaction_count(signer.address(), Some(BlockId::Number(BlockNumber::Latest)))
            .await
            .expect("failed to get nonce");
        gauge!("nonce", nonce.as_u64() as f64);

        let mut success = false;
        for attempt in 0..SEND_ATTEMPTS {
            let start = time::Instant::now();
            info!("sending tx, nonce={nonce}, gas_price={gas_price}, attempt={attempt}");

            if let Some(receipt) = try_submit_and_wait(&signer, gas_price, nonce).await {
                gauge!("watchdog.tx.latency.total", start.elapsed());
                let gas_used = receipt.gas_used.unwrap().as_u64() as f64;
                gauge!("watchdog.tx.gas", gas_used, "type" => "gas_used");
                let status = receipt.status.unwrap().as_u64() as f64;
                gauge!("watchdog.tx.status", status);
                info!(
                    "received confirmation for the tx {:?}",
                    receipt.transaction_hash
                );

                success = true;
                break;
            }

            gas_price *= GAS_SCALE_FACTOR;
        }

        if success {
            increment_counter!("watchdog.liveness");
            info!("sleeping for {} seconds", TX_PERIOD_SEC);
            tokio::time::sleep(Duration::from_secs(TX_PERIOD_SEC)).await;
        } else {
            error!("did not get included tx, starting over without sleeping..");
        }
    }
}
