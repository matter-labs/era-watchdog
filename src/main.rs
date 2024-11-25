mod default_flow;
// mod paymaster_flow;
mod deposit_flow;
mod conversion_traits;

use std::{env, time};

use crate::default_flow::DefaultFlow;
use alloy::network::Ethereum;
use alloy::providers::ProviderBuilder;
use alloy::providers::{PendingTransactionBuilder, Provider};
use alloy::rpc::client::RpcClient;
use alloy::transports::http::reqwest::Url;
use alloy::transports::BoxTransport;
use dotenv::dotenv;
use eyre::Result;
use metrics::{gauge, increment_counter};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::{task::JoinHandle, time::Duration};
use tracing::{info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter}; //paymaster_flow::PaymasterFlow

pub fn run_prometheus_exporter() -> JoinHandle<()> {
    let builder = {
        let addr = ([0, 0, 0, 0], 8081);
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
trait SimpleTxFlow {
    async fn estimate_gas(&self) -> anyhow::Result<u64>;
    async fn send_transaction(
        &self,
    ) -> anyhow::Result<PendingTransactionBuilder<BoxTransport, Ethereum>>;
}

fn create_transaction_flow<'a, P>(
    paymaster_address: Option<String>,
    pk: String,
    provider: P,
) -> Box<dyn SimpleTxFlow + 'a>
where
    P: Provider + 'a,
{
    match paymaster_address {
        Some(x) => panic!("Unimplemented!"), //Box::new(PaymasterFlow::new(pk, x, chain_id, provider)),
        None => Box::new(DefaultFlow::new(pk, provider)),
    }
}

async fn simple_transaction_loop<P>(paymaster_address: Option<String>, pk: String, provider: P) -> ()
where
    P: Provider + Clone,
{
    // Every 5 minutes
    const TX_PERIOD: u64 = 300;

    loop {
        let flow = create_transaction_flow(
            paymaster_address.clone(),
            pk.clone(),
            provider.clone(),
        );
        // Estimate gas
        let estimate_gas_start = time::Instant::now();
        let gas_estimation = flow
            .estimate_gas()
            .await
            .expect("failed to get a gas estimate from the CHAIN_RPC_URL");

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
            .with_required_confirmations(0)
            .get_receipt()
            .await
        {
            Ok(receipt) => {
                gauge!("watchdog.tx.latency", confirmation_start.elapsed(), "stage" => "mempool");
                receipt
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

        let gas_used = receipt.gas_used as f64;
        gauge!("watchdog.tx.gas", gas_used, "type" => "gas_used");
        let status = if receipt.status() { 0f64 } else { 1f64 };
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

async fn deposit_loop<P>(pk: String, providerL1: P, providerL2: P) -> () where P: Provider + Clone {

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
    let l2_rpc_url =
        env::var("L2_RPC_URL").expect("couldn't read environment variable L2_RPC_URL");
    let l1_rpc_url =
        env::var("L1_RPC_URL").expect("couldn't read environment variable L1_RPC_URL");

    let paymaster_address = env::var("PAYMASTER_ADDRESS").ok();

    let l2_rpc_url: Url = l2_rpc_url
        .parse()
        .expect("failed to parse L2 provider url");

    let rpc_client_l2 = RpcClient::new_http(l2_rpc_url).with_poll_interval(Duration::from_millis(100));
    let provider_l2 = ProviderBuilder::new().on_client(rpc_client_l2).boxed();

    let l1_rpc_url: Url = l1_rpc_url
        .parse()
        .expect("failed to parse L2 provider url");

    let rpc_client_l1 = RpcClient::new_http(l1_rpc_url).with_poll_interval(Duration::from_millis(100));
    let provider_l1 = ProviderBuilder::new().on_client(rpc_client_l1).boxed();


    tokio::join!(
        simple_transaction_loop(paymaster_address, pk.clone(), provider_l2.clone()),
        deposit_loop(pk, provider_l1, provider_l2),
    );
    Ok(())
}
