'use strict';

const tls = require('tls');
const { request: httpRequest, Agent: HttpAgent } = require('http');
const { request: httpsRequest, Agent: HttpsAgent } = require('https');
const { inherits, debuglog } = require('util');
const debug = debuglog('betterHttpsProxyAgent');

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

Agent.prototype.createConnection = function createConnection(options, callback) {
	options = Object.assign({}, options);

	const maxSockets = this[OPTIONS].maxSockets;
	if (maxSockets && maxSockets === this[ACTIVE_SOCKETS]) {
		debug('createConnection exceeded maxSockets', options);

		this[WAITING_REQUESTS].push({
			options,
			callback
		});

		return;
	}

	debug('createConnection', options);

	this[ACTIVE_SOCKETS]++;

	if (options._agentKey) {
		const session = this._getSession(options._agentKey);

		if (session) {
			debug('reuse session for %j', options._agentKey);
			options = Object.assign({
				session: session
			}, options);
		}
	}

	this._createProxyConnection(options, (err, socket) => {
		if (err) {
			callback(err);

			return;
		}

		let calledBack = false;

		options.socket = socket;

		const tlsSocket = tls.connect(options, () => {
			if (!options._agentKey) {
				return;
			}

			this._cacheSession(options._agentKey, tlsSocket.getSession());

			calledBack = true;
			callback(null, tlsSocket);
		});

		tlsSocket.once('error', (err) => {
			if (!calledBack) {
				calledBack = true;
				callback(err);
			}
		});

		tlsSocket.once('close', (hadError) => {
			if (hadError) {
				this._evictSession(options._agentKey);
			}

			this[ACTIVE_SOCKETS]--;

			const waiting = this[WAITING_REQUESTS].shift();

			if (waiting) {
				debug('createConnection for waiting request');

				this.createConnection(waiting.options, waiting.callback);
			}
		});
	});
};

Agent.prototype._createProxyConnection = function _createProxyConnection(throughOptions, callback) {
	const toOptions = Object.assign({}, this[OPTIONS]);
	toOptions.method = 'CONNECT';
	toOptions.path = throughOptions.host + ':' + throughOptions.port
	// toOptions.headers = { host: throughOptions.host };

	debug('_createProxyConnection', toOptions);

	const request = (toOptions.protocol === 'https:' ? httpsRequest : httpRequest)(toOptions);

	if (typeof throughOptions.timeout !== 'undefined') {
		request.setTimeout(throughOptions.timeout);
	}

	request.on('connect', function(res, socket, head) {
		callback(null, socket);
	});

	request.on('error', function(err) {
		callback(err);
	});

	request.end();
};

Agent.prototype.getName = function getName(options) {
	return HttpsAgent.prototype.getName.call(this, options) + ':'
			+ this[OPTIONS].agent.getName(options);
};

module.exports.Agent = Agent;
