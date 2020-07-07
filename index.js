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

	const stream = this._createSurrogateStream(() => {
		request.abort();
	});

	const request = this._createProxyConnection(options, (err, socket) => {
		if (err) {
			stream.emit('error', err);

			return;
		}

		options.socket = socket;

		const tlsSocket = tls.connect(options, () => {
			if (options._agentKey) this._cacheSession(options._agentKey, tlsSocket.getSession());
		});

		this._connectSurrogateStream(stream, tlsSocket);

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

	request.on('timeout', () => {
		stream.emit('timeout');
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

Agent.prototype._createSurrogateStream = function _createSurrogateStream(destroyer) {
	const stream = duplexify(null, null, {
		/*
		 * Don't end the writable stream when the readable stream ends.
		 */
		end: false
	});

	stream.surrogateConnectedStream = null;
	stream.surrogateTimeout = undefined;
	stream.surrogateKeepAliveEnable = undefined;
	stream.surrogateKeepAliveDelay = undefined;
	stream.surrogateReffed = true;
	stream.surrogateDestroy = destroyer;

	/*
	 * These methods 'buffer' their side effects until the surrogate is connected.
	 */

	stream.setTimeout = surrogateSetTimeout;
	stream.setKeepAlive = surrogateSetKeepAlive;
	stream.ref = surrogateRef;
	stream.unref = surrogateUnref;
	stream.destroy = surrogateDestroy;

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

	tlsSocket.surrogateDestroy = null;

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
	stream.destroy = connectedDestroy;

	/*
	 * Forward the 'timeout' and 'connect' events, as they are not standard stream events.
	 */
	tlsSocket.on('timeout', connectedOnTimeout);
	tlsSocket.on('connect', connectedOnConnect);

	/*
	 * Although the 'duplexify' documentation states, "If the readable or 
	 * writable streams emits an error or close it will destroy both streams and 
	 * bubble up the event," this does not appear to be reliable, but I have been
	 * unable to reproduce the situation using mocks. Propagate the events ourselves
	 * to be safe.
	 *
	 * 'duplexify' also doesn't set writable to false when the stream is closed, even
	 * though it is no longer safe to call write(). We deal with that, too.
	 */
	tlsSocket.once('error', connectedOnError);
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
		if (res.statusCode === 200) {
			callback(null, socket);
		} else {
			const error = new Error(res.statusMessage);
			error.code = res.statusCode;
			callback(error);

			/*
			 * There is no expectation of reuse of a socket when using CONNECT, so although
			 * we theoretically could reuse it, we don't bother. It's simpler to destroy it.
			 */
			socket.destroy();
		}
	});

	request.on('error', callback);

	request.end();

	return request;
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

function surrogateDestroy() {
	this.surrogateDestroy();

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

function connectedDestroy() {
	this.surrogateConnectedStream.destroy();

	return this;
}

function connectedOnTimeout() {
	this.surrogateStream.emit('timeout')
}

function connectedOnConnect() {
	this.surrogateStream.emit('connect')
}

function connectedOnError(error) {
	this.surrogateStream.emit('error', error);
}

function connectedOnClose() {
	this.surrogateStream.writable = false;
	this.surrogateStream.emit('close');
}

module.exports.Agent = Agent;
