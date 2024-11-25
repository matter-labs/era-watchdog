use std::sync::Arc;

use crate::conversion_traits::ToEthers;
use crate::SimpleTxFlow;
use alloy::network::{Ethereum, EthereumWallet, TransactionBuilder};
use alloy::primitives::{address, Address, Bytes};
use alloy::providers::{PendingTransactionBuilder, Provider, WalletProvider};
use alloy::rpc::client::NoParams;
use alloy::rpc::types::TransactionRequest;
use alloy::transports::BoxTransport;
use alloy::{primitives::U256, providers::ProviderBuilder, signers::local::PrivateKeySigner, sol};
use zksync_types::api::Eip712Meta;

sol!(
    #[sol(rpc)]
    IBridgehub,
    "abi/IBridgehub.json",
);

/// this type is cursed
#[rustfmt::skip]
type ProviderWithWallet<P> = alloy::providers::fillers::FillProvider<alloy::providers::fillers::JoinFill<alloy::providers::fillers::JoinFill<alloy::providers::Identity, alloy::providers::fillers::JoinFill<alloy::providers::fillers::GasFiller, alloy::providers::fillers::JoinFill<alloy::providers::fillers::BlobGasFiller, alloy::providers::fillers::JoinFill<alloy::providers::fillers::NonceFiller, alloy::providers::fillers::ChainIdFiller>>>>, alloy::providers::fillers::WalletFiller<EthereumWallet>>, P, alloy::transports::BoxTransport, alloy::network::Ethereum>;

pub struct DepositFlow<P: Provider + Clone> {
    provider_l1: ProviderWithWallet<Arc<P>>,
    provider_l2: ProviderWithWallet<Arc<P>>,
    bridge_hub: Arc<IBridgehub::IBridgehubInstance<BoxTransport, ProviderWithWallet<Arc<P>>>>
}

const REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT: u64 = 50000; // maybe 0? maybe  800?

async fn get_bridge_hub_address<P>(provider_l2: &P) -> Address
where
    P: Provider,
{
    let address_str: String = provider_l2
        .raw_request("zks_getBridgehubContract".into(), NoParams::default())
        .await
        .expect("Could not get bridge hub address");
    address_str
        .parse()
        .expect("Could not parse bridge hub address")
}

impl<P: Provider + Clone + 'static> DepositFlow<P> {
    pub async fn new(pk: String, provider_l1: P, provider_l2: P) -> Self {
        let signer: PrivateKeySigner = pk.parse().expect("Could not parse private key");
        let wallet = EthereumWallet::new(signer);
        let wallet_provider_l1 = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet.clone())
            .on_provider(Arc::new(provider_l1.clone()));
        let wallet_provider_l2 = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_provider(Arc::new(provider_l2));

        let bridge_hub = IBridgehub::new(
            get_bridge_hub_address(&wallet_provider_l2).await,
            wallet_provider_l1.clone(),
        );

        Self {
            provider_l1: wallet_provider_l1,
            provider_l2: wallet_provider_l2,
            bridge_hub: Arc::new(bridge_hub)
        }
    }

    async fn get_base_token_l1_to_l2_gas(&self, deposit_value: &U256) -> u64 {
        let tx_request_for_limit = zksync_types::transaction_request::CallRequest {
            from: Some(self.provider_l1.default_signer_address().to_ethers()),
            to: Some(self.provider_l2.default_signer_address().to_ethers()),
            value: Some(deposit_value.to_ethers()),
            input: Some(vec![].into()),
            eip712_meta: Some(Eip712Meta {
                gas_per_pubdata: U256::from(REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT).to_ethers(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let l2_gas_limit: u64 = self
            .provider_l2
            .raw_request("zks_estimateGasL1ToL2".into(), (tx_request_for_limit,))
            .await
            .expect("Could not estimate l1_to_l2 gas");
        l2_gas_limit
    }

    // async fn get_l2_transaction_base_cost(self: Box<Self>, l2_chain_id: U256, max_fee_per_gas: U256, l2_gas_limit: U256, gas_per_pubdata_byte: U256) -> U256 {
    // self.bridge_hub.l2TransactionBaseCost(l2_chain_id, max_fee_per_gas, l2_gas_limit, gas_per_pubdata_byte).await.expect("Could not get l2 transaction base cost")._0
    // }

    async fn deposit_eth_to_eth_based(self: &Self) -> () {
        // async_scoped::AsyncStdScope::scope_and_block(|s| {
        let deposit_value = U256::from(1);
        let l2_chain_id = self
            .provider_l2
            .get_chain_id()
            .await
            .expect("Could not get chain id");
        /* some defaults
           *  tx.to = tx.to ?? (await this.getAddress());
        tx.operatorTip ??= 0;
        tx.overrides ??= {};
        tx.overrides.from = await this.getAddress();
        tx.gasPerPubdataByte ??= REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
        tx.l2GasLimit ??= await this._getL2GasLimit(tx);
          // normally here would be some custom fee logic to insert fees, but its confusing and I ommit it
           */
        let fees = self
            .provider_l1
            .estimate_eip1559_fees(None)
            .await
            .expect("Could not estimate fees");
        let gas_per_pubdata_byte = REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
        let l2_gas_limit = self.get_base_token_l1_to_l2_gas(&deposit_value).await;
        let base_cost = self.bridge_hub
            .l2TransactionBaseCost(
                U256::from(l2_chain_id),
                U256::from(fees.max_fee_per_gas),
                U256::from(l2_gas_limit),
                U256::from(gas_per_pubdata_byte),
            ).call()
            .await
            .expect("Could not get l2 transaction base cost")
            ._0;
        //self.get_l2_transaction_base_cost(l2_chain_id, fees.max_fee_per_gas, l2_gas_limit, gas_per_pubdata_byte).await;
        let value = U256::from(base_cost) /* + operator tip = 0 */ + deposit_value;
        // });
    }
}
