const http = require('http');
const https = require('https');
const tls = require('tls');
const { readFile } = require('./read-file');

const proxies = new Set();

/*
 * options.port: port to listen on (required)
 * options.authenticate: require a client certificate
 * options.cn: expected client certificate CN (implies authenticate)
 * options.failConnect: respond to CONNECT with a failure
 * options.hangConnect: milliseconds before responding to CONNECT; true to hang forever
 * options.hangRequest: milliseconds before responding with HTTP 200; true to hang forever
 * options.keepAlive: leave the socket open after responding with HTTP 200
 */
module.exports.startMockHttpProxy = async function(options) {
	options = Object.assign(await exampleAuthentication(), options);
	return (new MockProxy(http.createServer(), options)).start();
};

/*
 * See createMockHttpProxy.
 */
module.exports.createMockHttpsProxy = async function(options) {
	options = Object.assign(await exampleAuthentication(), options);
	return (new MockProxy(https.createServer(await localhostAuthentication()), options)).start();
};

module.exports.stopMockProxies = function() {
	return Promise.all(Array.from(proxies.values()).map((proxy) => proxy.stop()));
}

class MockProxy {

	constructor(server, options) {
		this.connections = [];
		this.requests = 0;
		this.errors = [];
		this._sockets = new Set();
		this._server = server;
		this._options = options;

		this._server.on('connect', (request, socket, head) => {
			if (head.length) {
				throw new Error("unexpected head");
			}

			this.connections.push(request.url);

			if (!this._options.hangConnect) {
				this._respondToConnection(socket);
				return;
			}

			if (this._options.hangConnect !== true) {
				setTimeout(this._respondToConnection.bind(this, socket),
						this._options.hangConnect);
				return;
			}

			this._sockets.add(socket);
		});
	}

	start() {
		return new Promise((resolve, reject) => {
			this._server.once('error', (err) => reject(err));
			this._server.listen(this._options.port, () => {
				proxies.add(this);
				resolve(this)
			});
		});
	}

	stop() {
		this._sockets.forEach((socket) => socket.end());
		return new Promise((resolve, reject) => {
			this._server.close((err) => {
				if (err) reject(err);
				else {
					proxies.delete(this);
					resolve();
				}
			});
		});
	}

	_respondToConnection(socket) {
		if (this._options.failConnect) {
			socket.write(['HTTP/1.1 500 Connection Error', '', ''].join('\r\n'));

			if (!this._options.keepAlive) {
				socket.end();
			} else {
				this._sockets.add(socket);
			}

			return;
		}

		socket.write(['HTTP/1.1 200 Connection Established', '', ''].join('\r\n'));

		const tlsSocket = new tls.TLSSocket(socket, {
			isServer: true,
			requestCert: this._requestCert(),
			ca: this._options.ca,
			cert: this._options.cert,
			key: this._options.key
		});

		/*
		 * For the mock, the response we give will be the same for every HTTP request,
		 * depending only on the TLS connection parameters.
		 */
		let response = ['HTTP/1.1 500 Internal Server Error',
				'Content-length: 0', '', ''].join('\r\n');

		tlsSocket.on('secure', () => {
			this._sockets.add(tlsSocket);

			response = this._determineHTTPResponse(tlsSocket);
		});

		tlsSocket.endHeadersBytesSeen = 0;
		tlsSocket.on('data', (chunk) => this._handleData(tlsSocket, response, chunk));

		tlsSocket.on('error', (err) => this.errors.push(err));
	}

	_requestCert() {
		return !!this._options.authenticate || this._options.cn;
	}

	_determineHTTPResponse(tlsSocket) {
		if (this._requestCert()) {
			let verifyError = tlsSocket._handle.verifyError();

			if (!verifyError && this._options.cn) {
				const cert = tlsSocket.getPeerCertificate();
				if (cert.subject.CN !== this._options.cn) {
					verifyError = new Error("unauthorized client");
				}
			}

			if (verifyError) {
				/* Assume the stack only contains ASCII */
				const stack = verifyError.stack;
				return ['HTTP/1.1 403 Forbidden',
						'Content-length: ' + stack.length, '', ''].join('\r\n') + stack;
			}
		}

		return ['HTTP/1.1 200 OK', 'Content-length: 7', '', ''].join('\r\n') + 'Success';
	}

	_handleData(tlsSocket, response, chunk) {
		for (let c=0; c<chunk.length; c++) {
			if (tlsSocket.endHeadersBytesSeen % 2) {
				if (chunk[c] === 10) tlsSocket.endHeadersBytesSeen++;
				else tlsSocket.endHeadersBytesSeen = 0;
			} else {
				if (chunk[c] === 13) tlsSocket.endHeadersBytesSeen++;
				else tlsSocket.endHeadersBytesSeen = 0;
			}

			if (tlsSocket.endHeadersBytesSeen === 4) {
				this.requests++;

				this._respondToHTTPRequest(tlsSocket, response);

				tlsSocket.endHeadersBytesSeen = 0;
			}
		}
	}

	_respondToHTTPRequest(tlsSocket, response) {
		if (!this._options.hangRequest) {
			this._sendHTTPResponse(tlsSocket, response);
			return;
		}

		if (this._options.hangRequest !== true) {
			setTimeout(this._sendHTTPResponse.bind(this, tlsSocket, response),
					this._options.hangRequest);
			return;
		}
	}

	_sendHTTPResponse(tlsSocket, response) {
		tlsSocket.write(response);

		if (!this._options.keepAlive) {
			tlsSocket.end();

			this._sockets.delete(tlsSocket);
		}
	}

}

async function exampleAuthentication() {
	const [ ca, cert, key ] = await Promise.all([
		readFile(__dirname + "/example.crt.pem"),
		readFile(__dirname + "/example.crt.pem"),
		readFile(__dirname + "/example.key.pem")
	]);
	return { ca, cert, key };
}

async function localhostAuthentication() {
	const [ ca, cert, key ] = await Promise.all([
		readFile(__dirname + "/localhost.crt.pem"),
		readFile(__dirname + "/localhost.crt.pem"),
		readFile(__dirname + "/localhost.key.pem")
	]);
	return { ca, cert, key };
}
