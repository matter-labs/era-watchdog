mod default_flow;
mod paymaster_flow;

use std::{convert::TryFrom, env, time};

use dotenv::dotenv;
use ethers::prelude::*;
use eyre::Result;
use metrics::{gauge, increment_counter};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::{task::JoinHandle, time::Duration};
use tracing::{info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{default_flow::DefaultFlow, paymaster_flow::PaymasterFlow};

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

#[async_trait::async_trait]
trait WatchdogFlow {
    async fn estimate_gas(&self) -> anyhow::Result<U256>;
    async fn send_transaction(&self) -> anyhow::Result<PendingTransaction<Http>>;
}

fn create_flow(
    paymaster_address: Option<String>,
    pk: String,
    chain_id: u64,
    provider: Provider<Http>,
) -> Box<dyn WatchdogFlow> {
    match paymaster_address {
        Some(x) => Box::new(PaymasterFlow::new(pk, x, chain_id, provider)),
        None => Box::new(DefaultFlow::new(pk, chain_id, provider)),
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

    let paymaster_address = env::var("PAYMASTER_ADDRESS").ok();

    // Connect to the network
    let provider = Provider::<Http>::try_from(chain_rpc_url).expect("failed to create provider");

    let chain_id = provider
        .get_chainid()
        .await
        .expect("failed to get the chain id from provider");

    let flow = create_flow(paymaster_address, pk, chain_id.as_u64(), provider.clone());

    // Fetch the latest gas price from the provider
    let gas_price = provider
        .get_gas_price()
        .await
        .expect("failed to fetch gas price")
        .as_u64();

    info!(
        "received the gas price from the CHAIN_RPC_URL: {}",
        gas_price
    );
    gauge!("gas_price", gas_price as f64);

    // Every 5 minutes
    const TX_PERIOD: u64 = 300;

    loop {
        // Estimate gas
        let estimate_gas_start = time::Instant::now();
        let gas_estimation = flow
            .estimate_gas()
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
        let pending_tx = match flow.send_transaction().await {
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

                increment_counter!("watchdog.liveness");

                tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
                continue;
            }
        };

        // Wait for the transaction to be mined and get the receipt
        let confirmation_start = time::Instant::now();
        let receipt = match pending_tx
            .confirmations(0)
            .interval(Duration::from_millis(100))
            .await
        {
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
        let status = receipt.status.unwrap().as_u64() as f64;
        gauge!("watchdog.tx.status", status);

        info!(
            "received confirmation for the tx {:?}",
            receipt.transaction_hash
        );
        increment_counter!("watchdog.liveness");

        // Sleep until the next iteration
        info!("sleeping for {} seconds", TX_PERIOD);
        tokio::time::sleep(Duration::from_secs(TX_PERIOD)).await;
    }
}
