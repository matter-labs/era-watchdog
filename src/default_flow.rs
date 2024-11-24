use alloy::transports::BoxTransport;
use alloy::{
    primitives::U256,
    providers::ProviderBuilder,
    signers::local::PrivateKeySigner,
};
use alloy::network::{Ethereum, EthereumWallet, TransactionBuilder};
use alloy::providers::{PendingTransactionBuilder, Provider, WalletProvider};
use alloy::rpc::types::TransactionRequest;
use crate::SimpleTxFlow;

pub struct DefaultFlow<P:Provider> {
    // this type is cursed
    provider: alloy::providers::fillers::FillProvider<alloy::providers::fillers::JoinFill<alloy::providers::fillers::JoinFill<alloy::providers::Identity, alloy::providers::fillers::JoinFill<alloy::providers::fillers::GasFiller, alloy::providers::fillers::JoinFill<alloy::providers::fillers::BlobGasFiller, alloy::providers::fillers::JoinFill<alloy::providers::fillers::NonceFiller, alloy::providers::fillers::ChainIdFiller>>>>, alloy::providers::fillers::WalletFiller<EthereumWallet>>, P, alloy::transports::BoxTransport, alloy::network::Ethereum>,
}

impl<P: Provider> DefaultFlow<P> {
    pub fn new(pk: String, provider: P) -> Self
    {
        let signer: PrivateKeySigner = pk.parse().expect("Could not parse private key");
        let wallet = EthereumWallet::new(signer);
        let new_provider = ProviderBuilder::new().with_recommended_fillers().wallet(wallet).on_provider(provider);
        Self { provider: new_provider }
    }

    fn tx_request(&self) -> TransactionRequest {
        // Sending 1 wei to ourselves
        TransactionRequest::default()
            .with_from(self.provider.default_signer_address())
            .with_to(self.provider.default_signer_address())
            .with_value(U256::from(1))
    }
}

#[async_trait::async_trait]
impl<P:Provider> SimpleTxFlow for DefaultFlow<P> {
    async fn estimate_gas(&self) -> anyhow::Result<u64> {
        self.provider.estimate_gas(&self.tx_request()).await.map_err(anyhow::Error::new)
    }

    async fn send_transaction(&self) -> anyhow::Result<PendingTransactionBuilder<BoxTransport, Ethereum>> {
        self.provider
            .send_transaction(self.tx_request())
            .await
            .map_err(anyhow::Error::new)
    }
}
