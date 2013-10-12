coinpunk.Wallet = function(walletKey, walletId) {
  this.network = coinpunk.config.network || 'prod';
  this.walletKey = walletKey;
  this.walletId = walletId;
  this.defaultIterations = 1000;
  this.serverKey = undefined;
  this.transactions = [];
  this.unspent = [];
  var keyPairs = [];

  this.loadPayloadWithLogin = function(id, password, payload) {
    this.createWalletKey(id, password);
    this.loadPayload(payload);
    return true;
  };

  this.loadPayload = function(payload) {
    var decrypted = JSON.parse(sjcl.decrypt(this.walletKey, payload));
    keyPairs = decrypted.keyPairs;
    this.transactions = decrypted.transactions || [];
    this.unspent = decrypted.unspent || [];
    return true;
  };

  this.createNewAddress = function(name, isChange) {
    var eckey      = new Bitcoin.ECKey();
    var newKeyPair = {
      key: eckey.getExportedPrivateKey(this.network),
      publicKey: Bitcoin.convert.bytesToHex(eckey.getPubKeyHash()),
      address: eckey.getBitcoinAddress(this.network).toString(),
      isChange: (isChange || false)
    };

    if(name)
      newKeyPair.name = name;

    keyPairs.push(newKeyPair);
    return newKeyPair.address;
  };

  this.getAddressName = function(address) {
    for(var i=0;i<keyPairs.length;i++) {
      if(keyPairs[i].address == keyPairs[i].address) {
        return keyPairs[i].name;
      }
    }
  };

  this.addresses = function() {
    var addrs = [];
    for(var i=0; i<keyPairs.length; i++) {
      addrs.push({address: keyPairs[i].address, name: keyPairs[i].name, isChange: keyPairs[i].isChange});
    }
    return addrs;
  };

  this.receiveAddressHashes = function() {
    var addrHashes = [];
    for(var i=0; i<keyPairs.length; i++) {
      if(keyPairs[i].isChange != true)
        addrHashes.push(keyPairs[i].address);
    }
    
    return addrHashes;
  };

  this.addressHashes = function() {
    var addresses = this.addresses();
    var addressHashes = [];
    for(var i=0;i<addresses.length;i++)
      addressHashes.push(addresses[i].address);
    return addressHashes;
  }

  this.createServerKey = function() {
    this.serverKey = sjcl.codec.base64.fromBits(sjcl.misc.pbkdf2(this.walletKey, this.walletId, this.defaultIterations));
    return this.serverKey;
  };

  this.createWalletKey = function(id, password) {
    this.walletKey = sjcl.codec.base64.fromBits(sjcl.misc.pbkdf2(password, id, this.defaultIterations));
    this.walletId = id;
    this.createServerKey();
    return this.walletKey;
  };

  this.encryptPayload = function() {
    var payload = {keyPairs: keyPairs, transactions: this.transactions, unspent: this.unspent};
    return sjcl.encrypt(this.walletKey, JSON.stringify(payload));
  };

  this.storeCredentials = function() {
    coinpunk.database.set(this.walletKey, this.walletId);
  };

  this.mergeUnspent = function(newUnspent) {
    var changed = false;
    this.unspentConfirmations = this.unspentConfirmations || {};

    for(var i=0;i<newUnspent.length;i++) {
      var match = false;
      
      for(var j=0;j<this.unspent.length;j++) {
        if(this.unspent[j].hash == newUnspent[i].hash)
          match = true;
      }

      this.unspentConfirmations[newUnspent[i].hash] = newUnspent[i].confirmations;

      if(match == true)
        continue;

      changed = true;
      this.unspent.push(newUnspent[i]);

      // todo: time should probably not be generated here
      
      var txMatch = false;

      for(var k=0;k<this.transactions.length;k++) {
        if(this.transactions[k].hash == newUnspent[i].hash)
          txMatch = true;
      }
      
      if(txMatch == false) {
        this.transactions.push({
          hash: newUnspent[i].hash,
          type: 'receive',
          address: newUnspent[i].address,
          amount: newUnspent[i].amount,
          time: new Date().getTime()
        });
      }
    }

    return changed;
  };
  
  this.unspentBalance = function(confirmations) {
    var confirmations = confirmations || 0;
    var amount = new BigNumber(0);

    for(var i=0; i<this.unspent.length; i++) {
      if(this.unspentConfirmations[this.unspent[i].hash] >= confirmations)
        amount = amount.plus(this.unspent[i].amount);
    }

    return amount.toString();
  };

  this.createSend = function(amtString, feeString, addressString, changeAddress) {
    var amt = Bitcoin.util.parseValue(amtString);
    
    if(amt == Bitcoin.BigInteger.ZERO)
      throw "spend amount must be greater than zero";
      
    if(!changeAddress)
      throw "change address was not provided";
    
    var fee = Bitcoin.util.parseValue(feeString || '0');
    var total = Bitcoin.BigInteger.ZERO.add(amt).add(fee);
    
    var address = new Bitcoin.Address(addressString, this.network);
    var sendTx = new Bitcoin.Transaction();
    var i;

    var unspent = [];
    var unspentAmt = Bitcoin.BigInteger.ZERO;

    for(i=0;i<this.unspent.length;i++) {
      unspent.push(this.unspent[i]);
      
      var amountSatoshiString = new BigNumber(this.unspent[i].amount).times(Math.pow(10,8)).toString();

      unspentAmt = unspentAmt.add(new Bitcoin.BigInteger(amountSatoshiString));
      
      // If > -1, we have enough to send the requested amount
      if(unspentAmt.compareTo(total) > -1) {
        break;
      }
    }

    if(unspentAmt.compareTo(total) < 0) {
      throw "you do not have enough bitcoins to send this amount";
    }
    
    for(i=0;i<unspent.length;i++) {
      sendTx.addInput({hash: unspent[i].hash}, unspent[i].vout);
    }
    
    // The address you are sending to, and the amount:
    sendTx.addOutput(address, amt);
    
    var remainder = unspentAmt.subtract(total);
    
    if(!remainder.equals(Bitcoin.BigInteger.ZERO)) {
      sendTx.addOutput(changeAddress, remainder);
    }
    
    var hashType = 1; // SIGHASH_ALL
    
    // Here will be the beginning of your signing for loop

    for(i=0;i<unspent.length;i++) {
      var unspentOutScript = new Bitcoin.Script(Bitcoin.convert.hexToBytes(unspent[i].scriptPubKey));
      var hash = sendTx.hashTransactionForSignature(unspentOutScript, i, hashType);
      var pubKeyHash = unspentOutScript.simpleOutHash();
      var pubKeyHashHex = Bitcoin.convert.bytesToHex(pubKeyHash);

      for(var j=0;j<keyPairs.length;j++) {
        if(_.isEqual(keyPairs[j].publicKey, pubKeyHashHex)) {
          var key = new Bitcoin.Key(keyPairs[j].key);
          var signature = key.sign(hash);
          signature.push(parseInt(hashType, 10));

          sendTx.ins[i].script = Bitcoin.Script.createInputScript(signature, key.getPub());
          break;
        }
      }
    }

    this.transactions.push({
      hash: Bitcoin.convert.bytesToHex(sendTx.getHash()),
      type: 'send',
      address: addressString,
      amount: Bitcoin.util.formatValue(amt),
      fee: Bitcoin.util.formatValue(fee),
      time: new Date().getTime()
    });

    var raw = Bitcoin.convert.bytesToHex(sendTx.serialize());

    // Remove unspent elements now that we have a tx that uses them
    for(var i=0;i<unspent.length;i++)
      this.unspent.shift();

    return raw;
  };

  if(walletKey && walletId)
    this.createServerKey();
};