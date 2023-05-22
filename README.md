# era-watchdog
Submits transactions periodically on-chain and exports related metrics by
running a prometheus exporter.

## Background
We want to ensure that even during periods of low activity (0 TPS), the chain
remains healthy and operates as intended. To achieve this, we need to
distinguish genuine low activity from outages. Knowing whether the chain is
healthy or not is important given the potential for sudden increases in activity
and the need for the chain to be able to handle those changes seamlessly.

For more details, please see the [design doc](https://www.notion.so/matterlabs/Specs-Database-f147ab46eb0e4c4293adf6fa13dccaa8?p=e7ff2347c1cc4a2fa69de08d36caef16&pm=s).

## Running the Service
Load the necessary environement variables:
```bash
CHAIN_RPC_URL=https://zksync2-testnet.zksync.dev:443
WALLET_KEY=deadbeef
```

start the service:
```bash
cargo run
```

scrape the metrics from port `8080`
