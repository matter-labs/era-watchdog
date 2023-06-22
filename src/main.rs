use std::convert::TryFrom;
use std::{env, sync::Arc, time};

use dotenv::dotenv;
use ethers::{prelude::*, types::transaction::eip2718::TypedTransaction};
use eyre::Result;
use log::{info, warn, LevelFilter};
use metrics::{counter, gauge, increment_counter};
use metrics::{gauge, increment_counter};
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
    // Logger config
    env_logger::builder().filter_level(LevelFilter::Info).init();

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

    info!("received the gas price from the CHAIN_RPC_URL");
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
        let tx_submit_start = time::Instant::now();
        let send_transaction_start = time::Instant::now();
        let pending_tx = match signer.send_transaction(tx, None).await {
            Ok(pending_tx) => {
                info!("sent the transaction to the mempool");
                gauge!("watchdog.tx.latency", send_transaction_start.elapsed(), "stage" => "send_transaction");
                pending_tx
            }
            Err(err) => {
                warn!("failed to send transaction: {:?}", err);
                gauge!("watchdog.tx.status", 0.0);

                increment_counter!("watchdog.liveness");

                tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
                continue;
            }
        };

        // Wait for the transaction to be mined and get the receipt
        let confirmation_start = time::Instant::now();
        let receipt = match pending_tx.confirmations(0).await {
            Ok(receipt) => {
                gauge!("watchdog.tx.latency", confirmation_start.elapsed(), "stage" => "mempool");
                receipt.unwrap()
            }
            Err(err) => {
                warn!("failed to get transaction receipt: {:?}", err);

                increment_counter!("watchdog.liveness");

                // TODO(tmrtx): retry backoff
                tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
                continue;
            }
        };

        gauge!("watchdog.tx.latency.total", tx_submit_start.elapsed());

        let gas_used = receipt.gas_used.unwrap().as_u64() as f64;
        gauge!("watchdog.tx.gas", gas_used, "type" => "gas_used");
        let status = receipt.status.unwrap().as_u64();
        gauge!("watchdog.tx.status", 1.0, "result" => if status == 1 {"success"} else {"failure"});

        info!("received confirmation for the tx");
        increment_counter!("watchdog.liveness");

        // Sleep until the next iteration
        info!("sleeping for {} minutes", TX_PERIOD / 60);
        tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
    }
}
