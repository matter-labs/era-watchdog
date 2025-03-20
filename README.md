# ZK Stack Watchdog
Submits transactions periodically on-chain and exports related metrics by
running a prometheus exporter.

## Background
We want to ensure that even during periods of low activity (0 TPS), the chain
remains healthy and operates as intended. To achieve this, we need to
distinguish genuine low activity from outages. Knowing whether the chain is
healthy or not is important given the potential for sudden increases in activity
and the need for the chain to be able to handle those changes seamlessly.

For more details, please see the [design doc](https://www.notion.so/matterlabs/Era-Watchdog-e7ff2347c1cc4a2fa69de08d36caef16?pvs=4).

## Running the Service

### Local development

```bash
yarn
export WALLET_KEY=0xdeadbeef  # Wallet key to use
export CHAIN_RPC_URL=http://127.0.0.1:3052 # l2 json-rpc endpoint
export PAYMASTER_ADDRESS=0x111C3E89Ce80e62EE88318C2804920D4c96f92bb  # if using paymaster for transactions
export METRICS_PORT=8090  # Override to avoid collisions with zkstack server
export CHAIN_L1_RPC_URL=http://127.0.0.1:8545
yarn run start
```

### Production

- set environment variables:
    - `NODE_ENV=production` -- affects logging
    - `LOG_LEVEL` -- appropriate logging level
    - `CHAIN_RPC_URL` -- l2 json-rpc endpoint
    - `WALLET_KEY` -- watchdog wallet key (`0x` prefixed hex string)
    - `PAYMASTER_ADDRESS` -- set if transctions should use a paymaster
    - `METRICS_PORT` -- override of metrics port, defaults to 8080
    - transfer flow:
        - `FLOW_TRANSFER_ENABLE` -- set to `1` to enable transfer flow
        - `FLOW_TRANSFER_INTERVAL` -- transfer flow interval in ms
        - `FLOW_TRANSFER_EXECUTION_TIMEOUT` -- timeout of l2 transfer confirmation in ms
    - deposit flow:
        - `FLOW_DEPOSIT_ENABLE` -- set to `1` to enable deposit flow
        - `CHAIN_L1_RPC_URL` -- l1 json-rpc endpoint
        - `FLOW_DEPOSIT_INTERVAL` -- deposit flow interval in ms
        - `FLOW_DEPOSIT_RETRY_INTERVAL` -- deposit retry interval in ms (default to 5 minutes)
        - `FLOW_DEPOSIT_RETRY_LIMIT` -- deposit retry limit (default to 3)
        - `FLOW_DEPOSIT_L2_TIMEOUT` -- timeout of l2 deposit confirmation in ms
        - `MAX_LOGS_BLOCKS` -- max number of blocks in range of `eth_getLogs` request
    - deposit user flow: (observes onchain transaction and performs deposit if no transaction is detected for certain time)
        - `FLOW_DEPOSIT_USER_ENABLE` -- set to `1` to enable deposit user flow
        - `FLOW_DEPOSIT_USER_INTERVAL` -- deposit user flow interval in ms (frequency of quaring latest deposit)
        - `FLOW_DEPOSIT_USER_TX_TRIGGER_DELAY` -- delay in ms after which deposit user flow will trigger deposit transaction from watchdog wallet
        - `FLOW_DEPOSIT_L2_TIMEOUT`, `MAX_LOGS_BLOCKS`, `FLOW_DEPOSIT_RETRY_INTERVAL`, `FLOW_DEPOSIT_RETRY_LIMIT` shared with deposit flow
    - withdrawal flow: (performs only the L2 transaction of a withdrawal)
        - `FLOW_WITHDRAWAL_ENABLE` -- set to `1` to enable withdrawal flow
        - `FLOW_WITHDRAWAL_INTERVAL` -- withdrawal flow interval in ms
        - `FLOW_WITHDRAWAL_RETRY_LIMIT` -- number of retries for withdrawal flow (defaults to 10)
        - `FLOW_WITHDRAWAL_RETRY_INTERVAL` -- interval between retries in ms (defaults to 30sec)

- run the container