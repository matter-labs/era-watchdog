use std::convert::TryFrom;
use std::{env, sync::Arc, time};

use dotenv::dotenv;
use ethers::{prelude::*, types::transaction::eip2718::TypedTransaction};
use eyre::Result;
use metrics::{counter, gauge, increment_counter};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::task::JoinHandle;
use tokio::time::Duration;

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

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env variables
    dotenv().ok();

    // Start the prometheus exporter server
    run_prometheus_exporter();

    let pk = env::var("WALLET_KEY").expect("couldn't read environment variable WALLET_KEY");
    let chain_rpc_url =
        env::var("CHAIN_RPC_URL").expect("couldn't read environment variable CHAIN_RPC_URL");

    // Connect to the network
    let provider = Provider::<Http>::try_from(chain_rpc_url).expect("failed to create provider");

    // Fetch the latest gas price from the provider
    let gas_price = provider
        .get_gas_price()
        .await
        .expect("failed to fetch gas price");

    gauge!("gas_price", gas_price.as_u64() as f64);

    let chain_id = provider
        .get_chainid()
        .await
        .expect("failed to get the chain id from provider");

    // Create the wallet from the private key
    let wallet: LocalWallet = pk.parse::<LocalWallet>()?.with_chain_id(chain_id.as_u64());

    // Connect the wallet to the provider
    let signer = Arc::new(SignerMiddleware::new(provider, wallet));

    // Every 5 minutes
    const TX_PERIOD: u64 = 300;

    loop {
        // Sending 1 wei to ourselves
        let tx = TransactionRequest::pay(signer.address(), 1 as u64);

        let legacy_tx = TypedTransaction::Legacy(tx.clone().into());

        // Estimate gas
        let estimate_gas_start = time::Instant::now();
        let gas_estimation = signer
            .estimate_gas(&legacy_tx, None)
            .await
            .unwrap()
            .as_u64();
        gauge!("watchdog.tx.gas.estimate", gas_estimation as f64);

        gauge!(
            "watchdog.tx.latency.estimate_gas",
            estimate_gas_start.elapsed()
        );

        // Send the transaction
        let tx_submit_start = time::Instant::now();
        let pending_start = time::Instant::now();
        let pending_tx = match signer.send_transaction(tx, None).await {
            Ok(pending_tx) => {
                gauge!("watchdog.tx.latency.mempool", pending_start.elapsed());
                pending_tx
            }
            Err(err) => {
                eprintln!("failed to send transaction: {:?}", err);
                gauge!("watchdog.tx.status", 0.0);

                increment_counter!("watchdog.liveness");

                tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
                continue;
            }
        };

        // Wait for the transaction to be mined and get the receipt
        let submit_start = time::Instant::now();
        let receipt = match pending_tx.confirmations(1).await {
            Ok(receipt) => {
                gauge!("watchdog.tx.latency.submission", submit_start.elapsed());
                receipt.unwrap()
            }
            Err(err) => {
                eprintln!("failed to get transaction receipt: {:?}", err);

                increment_counter!("watchdog.liveness");

                // TODO(tmrtx): retry backoff
                tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
                continue;
            }
        };

        gauge!("watchdog.tx.latency.full", tx_submit_start.elapsed());

        let gas_used = receipt.gas_used.unwrap().as_u64() as f64;
        gauge!("watchdog.tx.gas.used", gas_used);
        let status = receipt.status.unwrap().as_u64() as f64;
        gauge!("watchdog.tx.status", status);

        increment_counter!("watchdog.liveness");
        // Wait for before the next iteration
        tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
    }
}
