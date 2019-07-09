'use strict';

const tls = require('tls');
const { request: httpRequest, Agent: HttpAgent } = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const { inherits, debuglog } = require('util');
const debug = debuglog('betterHttpsProxyAgent');
const duplexify = require('duplexify');

const OPTIONS = "_betterHttpsProxyOptions";
const ACTIVE_SOCKETS = "_betterHttpsProxyActiveSockets";
const WAITING_REQUESTS = "_betterHttpsProxyWaitingRequests";

function Agent(httpsAgentOptions, proxyRequestOptions) {
	if (!(this instanceof Agent)) {
		return new Agent(httpsAgentOptions, proxyRequestOptions);
	}

	HttpsAgent.call(this, httpsAgentOptions);

	proxyRequestOptions = Object.assign({}, proxyRequestOptions);
	proxyRequestOptions.protocol = proxyRequestOptions.protocol || 'http:';
	proxyRequestOptions.method = 'CONNECT';
	if (!proxyRequestOptions.agent) {
		proxyRequestOptions.agent = proxyRequestOptions.protocol === 'https:'
		                          ? new HttpsAgent()
		                          : new HttpAgent();
	}

	this[OPTIONS] = proxyRequestOptions;
	this[ACTIVE_SOCKETS] = 0;
	this[WAITING_REQUESTS] = [];
}
inherits(Agent, HttpsAgent);

Agent.prototype.createConnection = function createConnection(options) {
	options = Object.assign({}, options);

	const maxSockets = this[OPTIONS].maxSockets;
	if (maxSockets && maxSockets === this[ACTIVE_SOCKETS]) {
		debug('createConnection exceeded maxSockets', options);

		this[WAITING_REQUESTS].push(options);

		return;
	}

	debug('createConnection', options);

	this[ACTIVE_SOCKETS]++;

	this._augmentOptionsWithSession(options);

	const stream = this._createSurrogateStream();

	this._createProxyConnection(options, (err, socket) => {
		if (err) {
			stream.emit('error', err);

			return;
		}

		options.socket = socket;

		const tlsSocket = tls.connect(options, () => {
			this._connectSurrogateStream(stream, tlsSocket);

			if (options._agentKey) this._cacheSession(options._agentKey, tlsSocket.getSession());
		});

		tlsSocket.once('error', (err) => {
			if (!stream.surrogateConnectedStream) stream.emit('error', err);
		});

		tlsSocket.once('close', (hadError) => {
			if (hadError) this._evictSession(options._agentKey);

			this[ACTIVE_SOCKETS]--;

			const waiting = this[WAITING_REQUESTS].shift();

			if (waiting) {
				debug('createConnection for waiting request');

				this.createConnection(waiting);
			}
		});
	});

	return stream;
};

Agent.prototype._augmentOptionsWithSession = function _augmentOptionsWithSession(options) {
	if (!options._agentKey) return;

	if (options.session) return;

	const session = this._getSession(options._agentKey);

	if (!session) return;

	debug('reuse session for %j', options._agentKey);
	options.session = session;
};

Agent.prototype._createSurrogateStream = function _createSurrogateStream() {
	const stream = duplexify();

	stream.surrogateConnectedStream = null;
	stream.surrogateTimeout = undefined;
	stream.surrogateKeepAliveEnable = undefined;
	stream.surrogateKeepAliveDelay = undefined;
	stream.surrogateReffed = true;

	/*
	 * These methods 'buffer' their side effects until the surrogate is connected.
	 */

	stream.setTimeout = surrogateSetTimeout;
	stream.setKeepAlive = surrogateSetKeepAlive;
	stream.ref = surrogateRef;
	stream.unref = surrogateUnref;

	/*
	 * Utility method used both before and after the surrogate stream is connected.
	 */

	stream.setTimeoutListener = setTimeoutListener;

	return stream;
};

Agent.prototype._connectSurrogateStream = function _connectSurrogateStream(stream, tlsSocket) {
	stream.surrogateConnectedStream = tlsSocket;
	stream.setReadable(tlsSocket);
	stream.setWritable(tlsSocket);

	tlsSocket.surrogateStream = stream;
	tlsSocket.surrogateSeenEnd = false;

	/*
	 * Apply 'buffered' side effects.
	 */

	if (typeof stream.surrogateTimeout !== 'undefined') {
		tlsSocket.setTimeout(stream.surrogateTimeout);
	}

	if (typeof stream.surrogateKeepAliveEnable !== 'undefined') {
		tlsSocket.setKeepAlive(stream.surrogateKeepAliveEnable);
	}
	if (typeof stream.surrogateKeepAliveDelay !== 'undefined') {
		tlsSocket.setKeepAlive(stream.surrogateKeepAliveDelay);
	}

	if (!stream.surrogateReffed) tlsSocket.unref();

	/*
	 * These methods forward to the connected stream.
	 */

	stream.setTimeout = connectedSetTimeout;
	stream.setKeepAlive = connectedSetKeepAlive;
	stream.ref = connectedRef;
	stream.unref = connectedUnref;

	/*
	 * Forward the 'timeout' event, as it is not a standard stream event.
	 * Neither is the 'connect' event, but since the stream is already 'connected'
	 * when it is returned, we don't need that.
	 */
	tlsSocket.on('timeout', connectedOnTimeout);

	/*
	 * Although the 'duplexify' documentation states, "If the readable or 
	 * writable streams emits an error or close it will destroy both streams and 
	 * bubble up the event," on careful examination, `close` events only bubble
	 * up and destroy the stream if they are 'premature', which means they occur
	 * before an expected `end` event; `close` events are also emitted by the 
	 * 'duplexify' stream following an error. However, following an 'end' event, 
	 * no 'close' is emitted at all. Oops. We work around that problem here.
	 */
	tlsSocket.once('end', connectedOnEnd);
	tlsSocket.once('close', connectedOnClose);
};

Agent.prototype._createProxyConnection = function _createProxyConnection(throughOptions, callback) {
	const toOptions = Object.assign({}, this[OPTIONS]);
	toOptions.path = (throughOptions.hostname || throughOptions.host) + ':' + throughOptions.port

	debug('_createProxyConnection', toOptions);

	const request = (toOptions.protocol === 'https:' ? httpsRequest : httpRequest)(toOptions);

	if (typeof throughOptions.timeout !== 'undefined') {
		request.setTimeout(throughOptions.timeout);
	}

	request.on('connect', function(res, socket, head) {
		callback(null, socket);
	});

	request.on('error', callback);

	request.end();
};

Agent.prototype.getName = function getName(options) {
	return HttpsAgent.prototype.getName.call(this, options) + ':'
			+ this[OPTIONS].agent.getName(this[OPTIONS]);
};

function surrogateSetTimeout(timeout, callback) {
	this.surrogateTimeout = timeout;

	this.setTimeoutListener(timeout, callback);

	return this;
}

function surrogateSetKeepAlive(enable, initialDelay) {
	if (typeof enable === 'boolean') {
		this.surrogateKeepAliveEnable = enable;
	} else {
		initialDelay = enable;
	}

	if (initialDelay) this.surrogateKeepAliveDelay = initialDelay;

	return this;
}

function surrogateRef() {
	this.surrogateReffed = true;

	return this;
}

function surrogateUnref() {
	this.surrogateReffed = false;

	return this;
}

function setTimeoutListener(timeout, callback) {
	if (timeout) {
		if (callback) this.once('timeout', callback);
		return;
	}

	if (callback) {
		this.removeListener('timeout', callback);
		return;
	}

	this.removeAllListeners('timeout');
}

function connectedSetTimeout(timeout, callback) {
	this.surrogateConnectedStream.setTimeout(timeout);

	this.setTimeoutListener(timeout, callback);

	return this;
}

function connectedSetKeepAlive(enable, initialDelay) {
	this.surrogateConnectedStream.setKeepAlive(enable, initialDelay);

	return this;
}

function connectedRef() {
	this.surrogateConnectedStream.ref();

	return this;
}

function connectedUnref() {
	this.surrogateConnectedStream.unref();

	return this;
}

function connectedOnTimeout() {
	this.surrogateStream.emit('timeout')
}

function connectedOnEnd() {
	this.surrogateSeenEnd = true;
}

function connectedOnClose() {
	if (this.surrogateSeenEnd) this.surrogateStream.emit('close');
}

module.exports.Agent = Agent;
