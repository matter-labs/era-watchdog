use crate::WatchdogFlow;
use ethers::core::k256::ecdsa::signature::hazmat::PrehashSigner;
use ethers::core::k256::ecdsa::RecoveryId;
use ethers::prelude::transaction::eip712::Eip712Error;
use ethers::{
    abi::{Address, Bytes},
    core::k256::ecdsa::SigningKey,
    prelude::{PendingTransaction, *},
    providers::{Http, Provider},
    signers::{Signer, Wallet},
    types::U256,
};
use std::fmt::Debug;
use std::{str::FromStr, sync::Arc};
use zksync_web3_rs::eip712::Eip712Transaction;
use zksync_web3_rs::zks_utils::EIP712_TX_TYPE;
use zksync_web3_rs::{
    core::abi::{Contract, Token},
    eip712::{Eip712Meta, Eip712TransactionRequest, PaymasterParams},
    zks_provider::ZKSProvider,
    ZKSWallet,
};

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
            .value::<U256>(0u64.into())
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
        let tx_request = self.tx_request();

        tracing::info!("Preparing to send transaction {:?}", tx_request);
        let mut request: Eip712TransactionRequest = tx_request.try_into().map_err(|_e| {
            ProviderError::CustomError("error on send_transaction_eip712".to_owned())
        })?;

        let address = self.zk_wallet.l2_wallet.address();
        let gas_price = self.era_provider.get_gas_price().await?;
        tracing::info!("Gas price {}", gas_price);
        let nonce = self
            .era_provider
            .get_transaction_count(address, None)
            .await?;
        tracing::info!("Nonce {}", nonce);
        request = request
            .chain_id(self.zk_wallet.l2_wallet.chain_id())
            .nonce(nonce)
            .gas_price(gas_price)
            .max_fee_per_gas(gas_price);

        let custom_data = request.clone().custom_data;
        let fee = self.era_provider.estimate_fee(request.clone()).await?;
        tracing::info!("Estimated fee {:?}", fee);

        request = request
            .max_priority_fee_per_gas(fee.max_priority_fee_per_gas)
            .max_fee_per_gas(fee.max_fee_per_gas)
            .gas_limit(fee.gas_limit);
        let signable_data: Eip712Transaction = request
            .clone()
            .try_into()
            .map_err(|e: Eip712Error| ProviderError::CustomError(e.to_string()))?;
        let signature: Signature = self
            .zk_wallet
            .l2_wallet
            .sign_typed_data(&signable_data)
            .await
            .map_err(|e| ProviderError::CustomError(format!("error signing transaction: {e}")))?;
        request = request.custom_data(custom_data.custom_signature(signature.to_vec()));
        let encoded_rlp = &*request
            .rlp_signed(signature)
            .map_err(|e| ProviderError::CustomError(format!("Error in the rlp encoding {e}")))?;

        let result = self
            .era_provider
            .send_raw_transaction([&[EIP712_TX_TYPE], encoded_rlp].concat().into())
            .await?;

        Ok(result)
    }
}
