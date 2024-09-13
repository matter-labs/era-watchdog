use std::{str::FromStr, sync::Arc};

use ethers::{
    abi::{Address, Bytes},
    core::k256::ecdsa::SigningKey,
    prelude::{PendingTransaction, *},
    providers::{Http, Provider},
    signers::{Signer, Wallet},
    types::U256,
};
use zksync_web3_rs::{
    core::abi::{Contract, Token},
    eip712::{Eip712Meta, Eip712TransactionRequest, PaymasterParams},
    zks_provider::ZKSProvider,
    ZKSWallet,
};

use crate::WatchdogFlow;

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
    paymaster_encoded_input: Bytes,
    zk_wallet: ZKSWallet<Provider<Http>, SigningKey>,
    era_provider: Arc<SignerMiddleware<Provider<Http>, Wallet<SigningKey>>>,
}

impl PaymasterFlow {
    pub fn new(
        private_key: String,
        paymaster_address: String,
        chain_id: u64,
        provider: Provider<Http>,
    ) -> Self {
        let paymaster_contract =
            Contract::load(PAYMASTER_ABI.as_bytes()).expect("Failed to load the paymaster ABI");
        let paymaster_general_fn = paymaster_contract
            .function("general")
            .expect("Failed to get the general function");
        let wallet = Wallet::from_str(private_key.as_str())
            .expect("Failed to create wallet from private key");
        let signer = Wallet::with_chain_id(wallet, chain_id);
        let zk_wallet = ZKSWallet::new(signer, None, Some(provider.clone()), None).unwrap();
        let era_provider = zk_wallet
            .get_era_provider()
            .expect("Failed to get era provider from zk wallet");
        let paymaster_encoded_input = paymaster_general_fn
            .encode_input(&[Token::Bytes(vec![])])
            .expect("Failed to encode paymaster input");

        Self {
            paymaster: Address::from_str(paymaster_address.as_str()).ok().unwrap(),
            paymaster_encoded_input,
            zk_wallet,
            era_provider,
        }
    }

    fn tx_request(&self) -> Eip712TransactionRequest {
        let address = self.zk_wallet.l1_wallet.address();
        Eip712TransactionRequest::new()
            .from(address)
            .to(address)
            .value::<U256>(1u64.into())
            .custom_data(Eip712Meta::new().paymaster_params(PaymasterParams {
                paymaster: self.paymaster,
                paymaster_input: self.paymaster_encoded_input.clone(),
            }))
    }
}

#[async_trait::async_trait]
impl WatchdogFlow for PaymasterFlow {
    async fn estimate_gas(&self) -> anyhow::Result<U256> {
        self.era_provider
            .estimate_fee::<Eip712TransactionRequest>(self.tx_request())
            .await
            .map_err(anyhow::Error::new)
            .map(|fee| fee.gas_limit)
    }

    async fn send_transaction(&self) -> anyhow::Result<PendingTransaction<Http>> {
        let result = self
            .era_provider
            .send_transaction_eip712(&self.zk_wallet.l2_wallet, self.tx_request())
            .await?;
        Ok(result)
    }
}
