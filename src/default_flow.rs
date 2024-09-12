use crate::WatchdogFlow;
use ethers::middleware::SignerMiddleware;
use ethers::prelude::transaction::eip2718::TypedTransaction;
use ethers::prelude::TransactionRequest;
use ethers::providers::Http;
use ethers::providers::{Middleware, PendingTransaction, Provider};
use ethers::signers::{LocalWallet, Signer};
use std::sync::Arc;
use ethers::types::U256;

pub struct DefaultFlow {
    signer: Arc<SignerMiddleware<Provider<Http>, LocalWallet>>,
}

impl DefaultFlow {
    pub fn new(pk: String,
           chain_id: u64,
           provider: Provider<Http>) -> Self {
        let wallet: LocalWallet = pk.parse::<LocalWallet>().unwrap().with_chain_id(chain_id);
        let signer = Arc::new(SignerMiddleware::new(provider, wallet));
        Self {
            signer
        }
    }

    fn tx_request(&self) -> TransactionRequest {
        // Sending 1 wei to ourselves
        TransactionRequest::pay(self.signer.address(), 1u64)
    }
}

impl WatchdogFlow for DefaultFlow {
    async fn estimate_gas(&self) -> anyhow::Result<U256> {
        // Created to fit the expected type for estimate_gas function
        let legacy_tx = TypedTransaction::Legacy(self.tx_request());
        self.signer
            .estimate_gas(&legacy_tx, None)
            .await
            .map_err(anyhow::Error::new)
    }

    async fn send_transaction(&self) -> anyhow::Result<PendingTransaction<Http>> {
        self.signer.send_transaction(self.tx_request(), None).await.map_err(anyhow::Error::new)
    }
}