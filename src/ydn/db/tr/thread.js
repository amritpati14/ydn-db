// Copyright 2012 YDN Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Transaction thread.
 *
 * @author kyawtun@yathit.com (Kyaw Tun)
 */

goog.provide('ydn.db.tr.Thread');
goog.provide('ydn.db.tr.Thread.Policy');
goog.require('ydn.db.Request');




/**
 * Create transaction queue providing methods to run in non-overlapping
 * transactions.
 *
 * @param {!ydn.db.tr.Storage} storage base storage.
 * @param {number} ptx_no transaction queue number.
 * @param {ydn.db.tr.Thread.Policy=} opt_policy
 * @param {!Array.<string>=} opt_store_names store names as scope.
 * @param {ydn.db.base.TransactionMode=} opt_mode mode as scope.
 * @param {number=} opt_max_tx_no limit number of transaction created.
 * @constructor
 * @struct
 */
ydn.db.tr.Thread = function(storage, ptx_no, opt_policy,
                             opt_store_names, opt_mode, opt_max_tx_no) {

  /**
   * @final
   * @type {!ydn.db.tr.Storage}
   * @private
   */
  this.storage_ = storage;

  /**
   * Transaction thread number.
   * @final
   */
  this.q_no_ = ptx_no;

  /**
   * Transaction number, increase one as a transaction created from this thread.
   * @type {number}
   */
  this.tx_no_ = 0;

  /**
   * Request number, increase one as a request created from this thread. Reset
   * to 0 on each transaction.
   * @type {number}
   */
  this.r_no_ = 0;


  /**
   * @final
   * @protected
   */
  this.scope_store_names = opt_store_names;

  /**
   * @final
   * @protected
   */
  this.scope_mode = opt_mode;

  /**
   * @final
   * @protected
   */
  this.policy = opt_policy || ydn.db.tr.Thread.Policy.SINGLE;

  /**
   * @final
   * @protected
   */
  this.max_tx_no = opt_max_tx_no || 0;

  /**
   * Generator function on spawn synchronous thread.
   * @type {Function}
   * @private
   */
  this.generator_;

  /**
   * Generator completed callback.
   * @type {ydn.db.Request}
   * @private
   */
  this.gen_req_ = null;

  /**
   * Set break the active transaction by commit method.
   * @type {boolean}
   * @private
   */
  this.break_tx_ = false;
};


/**
 * Set generator
 * @param {Function} gen
 * @return {Function} callback to invoke when tx is committed or aborted.
 */
ydn.db.tr.Thread.prototype.setGenerator = function(gen, req) {
  goog.asserts.assert(!this.generator_, 'thread can have only one generator');
  this.generator_ = gen;
  this.gen_req_ = req;
  return goog.bind(this.onGenTxCommitted_, this);
};


/**
 * @param {ydn.db.base.TxEventTypes} type
 * @param {*} e
 * @private
 */
ydn.db.tr.Thread.prototype.onGenTxCommitted_ = function(type, e) {
  var done = type == ydn.db.base.TxEventTypes.COMPLETE ||
      type == ydn.db.base.TxEventTypes.ABORT;
  if (done && !this.break_tx_) {
    var success = type == ydn.db.base.TxEventTypes.COMPLETE;
    this.gen_req_.setDbValue(this.getTxNo(), !success);
  }
};


/**
 * Commit active transaction by setTimeout.
 */
ydn.db.tr.Thread.prototype.commit = function() {
  if (!goog.isDef(this.generator_)) {
    throw new ydn.debug.error.InvalidOperationException('Transaction thread' +
        ' not running in a generator');
  } else if (this.generator_) {
    this.break_tx_ = true;
  } else {
    // null
    throw new ydn.debug.error.InvalidOperationException('Coroutine' +
        ' transaction thread has been ended');
  }
};


/**
 * Send next result value to generator.
 * @param x
 * @private
 */
ydn.db.tr.Thread.prototype.sendNext_ = function(x) {
  if (this.break_tx_) {
    this.break_tx_ = false;
    var me = this;
    // let transaction be committed
    setTimeout(function() {
      // and create a new transaction.
      me.processTx(function(tx) {
        // new tx is active, start next request.
        // me.gen_req_.setTx(tx); // todo set correct tx, current implementation
        // not allow setting multiple tx setting.
        me.generator_['next'](x);
      }, /** @type {!Array.<string>} */ (me.scope_store_names), me.scope_mode,
          me.onGenTxCommitted_);

    }, 4);
  } else {
    this.generator_['next'](x);
  }
};


/**
 * Create an request.
 * @param {ydn.db.Request.Method} method request method.
 * @param {!Array.<string>} store_names store name involved in the transaction.
 * @param {ydn.db.base.TransactionMode=} opt_mode mode, default to 'readonly'.
 * @param {function(ydn.db.base.TxEventTypes, *)=} opt_oncompleted handler.
 * @return {!ydn.db.Request}
 */
ydn.db.tr.Thread.prototype.request = function(method, store_names, opt_mode,
                                              opt_oncompleted) {
  var req = new ydn.db.Request(method);
  if (this.generator_) {
    req.addCallbacks(function(x) {
      this.sendNext_(x);
    }, function(e) {
      var err = e;
      if (!(e instanceof Error)) {
        err = new Error();
        err['error'] = e;
      }
      this.sendNext_(err);
    }, this);
  }

  return req;
};


/**
 * @param {!goog.async.Deferred} df deferred object to intersect the request.
 * @param {?function((ydn.db.base.Transaction),
 * string, ?function(*, boolean=))} callback
 *   callback when executor is ready.
 * @param {!Array.<string>} store_names store name involved in the transaction.
 * @param {ydn.db.base.TransactionMode} mode mode, default to 'readonly'.
 * @param {function(ydn.db.base.TxEventTypes, *)=} opt_oncompleted handler.
 */
ydn.db.tr.Thread.prototype.exec = goog.abstractMethod;


/**
 * Abort an active transaction.
 */
ydn.db.tr.Thread.prototype.abort = goog.abstractMethod;


/**
 *
 * @return {number} transaction count.
 */
ydn.db.tr.Thread.prototype.getTxNo = function() {
  return this.tx_no_;
};


/**
 *
 * @return {string|undefined} mechansim type.
 */
ydn.db.tr.Thread.prototype.type = function() {
  return this.storage_.getType();
};



/**
 *
 * @return {number} transaction queue number.
 */
ydn.db.tr.Thread.prototype.getQueueNo = function() {
  return this.q_no_;
};


/**
 * Add or update a store issuing a version change event.
 * @protected
 * @param {!StoreSchema|!ydn.db.schema.Store} store schema.
 * @return {!goog.async.Deferred} promise.
 */
ydn.db.tr.Thread.prototype.addStoreSchema = function(store) {
  return this.storage_.addStoreSchema(store);
};


/**
 * @protected
 * @return {!ydn.db.tr.Storage} storage.
 */
ydn.db.tr.Thread.prototype.getStorage = function() {
  return this.storage_;
};


/**
 *
 * @return {string} label.
 */
ydn.db.tr.Thread.prototype.getLabel = function() {
  return 'B' + this.q_no_ + 'T' + this.tx_no_;
};


/**
 * Create a new isolated transaction. After creating a transaction, use
 * {@link #getTx} to received an active transaction. If transaction is not
 * active, it return null. In this case a new transaction must re-create.
 * @param {Function} trFn function that invoke in the transaction.
 * @param {!Array.<string>} store_names list of keys or
 * store name involved in the transaction.
 * @param {ydn.db.base.TransactionMode=} opt_mode mode, default to 'readonly'.
 * @param {function(ydn.db.base.TxEventTypes, *)=} opt_oncompleted handler.
 */
ydn.db.tr.Thread.prototype.processTx = goog.abstractMethod;


/**
 * Request type.
 * @enum {string}
 */
ydn.db.tr.Thread.Policy = {
  MULTI: 'multi',
  REPEAT: 'repeat',
  ALL: 'all',
  ATOMIC: 'atomic',
  SINGLE: 'single'
};


/**
 * Abort an active transaction.
 * @param {ydn.db.base.Transaction} tx transaction to be aborted.
 */
ydn.db.tr.Thread.abort = function(tx) {
  if (tx) {
    if (goog.isFunction(tx.abort)) {
      tx.abort();
    } else if (goog.isFunction(tx.executeSql)) {
      /**
       * @param {SQLTransaction} tr transaction.
       * @param {SQLError} error error.
       * @return {boolean} true to roll back.
       */
      var error_callback = function(tr, error) {
        // console.log(error);
        return true; // roll back
      };
      tx.executeSql('ABORT', [], null, error_callback);
      // this will cause error on SQLTransaction and WebStorage.
      // the error is wanted because there is no way to abort a transaction in
      // WebSql. It is somehow recommanded workaround to abort a transaction.
    } else {
      throw new ydn.debug.error.NotSupportedException();
    }

  } else {
    throw new ydn.db.InvalidStateError('No active transaction');
  }
};
