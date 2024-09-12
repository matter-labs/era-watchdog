use crate::WatchdogFlow;
use ethers::abi::Bytes;
use ethers::core::k256::ecdsa::SigningKey;
use ethers::prelude::PendingTransaction;
use ethers::prelude::*;
use ethers::providers::Http;
use ethers::{
    abi::Address
    ,
    providers::{Provider},
    signers::{Signer, Wallet},
    types::U256,
};
use std::str::FromStr;
use std::sync::Arc;
use zksync_web3_rs::core::abi::{Contract, Token};
use zksync_web3_rs::eip712::{Eip712Meta, Eip712TransactionRequest, PaymasterParams};
use zksync_web3_rs::zks_provider::ZKSProvider;
use zksync_web3_rs::ZKSWallet;

const PAYMASTER_ABI: &str = r#"
    [
      {
        "inputs": [
          {
            "internalType": "bytes",
            "name": "input",
            "type": "bytes"
          }
        ],
        "name": "general",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
      }
    ]
    "#;



pub struct PaymasterFlow {
    paymaster: Address,
    amount: U256,
    paymaster_encoded_input: Bytes,
    zk_wallet: ZKSWallet<Provider<Http>, SigningKey>,
    era_provider: Arc<SignerMiddleware<Provider<Http>, Wallet<SigningKey>>>,
}

impl PaymasterFlow {
    pub fn new(private_key: String,
           paymaster_address: String,
           chain_id: u64,
           provider:Provider<Http>) -> Self {
        let paymaster_contract = Contract::load(PAYMASTER_ABI.as_bytes()).expect("Failed to load the paymaster ABI");
        let paymaster_general_fn = paymaster_contract.function("general").expect("Failed to get the general function");
        let wallet = Wallet::from_str(private_key.as_str()).expect("Failed to create wallet from private key");
        let signer = Wallet::with_chain_id(wallet, chain_id);
        let zk_wallet = ZKSWallet::new(signer, None, Some(provider.clone()), None).unwrap();
        let era_provider = zk_wallet.get_era_provider().expect("Failed to get era provider from zk wallet");
        let paymaster_encoded_input = paymaster_general_fn.encode_input(&[Token::Bytes(vec![])]).expect("Failed to encode paymaster input");

        Self {
            paymaster: Address::from_str(paymaster_address.as_str()).ok().unwrap(),
            amount: U256::from_dec_str("1").expect("Failed to parse amount"),
            paymaster_encoded_input,
            zk_wallet,
            era_provider
        }
    }

    fn tx_request(&self) -> Eip712TransactionRequest {
        let address = self.zk_wallet.l1_wallet.address();
        let x = hex::encode(self.paymaster_encoded_input.clone());
        tracing::info!("Paymaster input {}", x);
        Eip712TransactionRequest::new()
            .from(address)
            .to(address)
            .value(self.amount)
            .custom_data(Eip712Meta::new().paymaster_params(PaymasterParams {
                paymaster: self.paymaster,
                paymaster_input: self.paymaster_encoded_input.clone()
            }))
    }
}

impl WatchdogFlow for PaymasterFlow {
    async fn estimate_gas(&self) -> anyhow::Result<U256> {
        self.era_provider.estimate_fee::<Eip712TransactionRequest>(self.tx_request().into())
            .await
            .map_err(|e| anyhow::Error::new(e))
            .map(|fee| fee.gas_limit)
    }

    async fn send_transaction(&self) -> anyhow::Result<PendingTransaction<Http>> {
        let result = self.era_provider
            .send_transaction_eip712(&self.zk_wallet.l2_wallet, self.tx_request())
            .await?;
        Ok(result)
    }
}