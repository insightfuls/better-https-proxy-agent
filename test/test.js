const { Agent } = require('../index');
const { startMockHttpProxy, startMockHttpsProxy, stopMockProxies } = require('./mock-proxy');
const https = require('https');
const { expect } = require('chai');
const { readFile } = require('./read-file');

const port = 8909;

describe("better-https-proxy-agent", () => {

	afterEach(() => {
		return stopMockProxies();
	});

	it("works", async () => {
		await requestAndVerify({
			agent: agent({}),
			mock: await startMockHttpProxy({ port }),
			expectations: {
				responseData: "Success",
				mockConnections: 1,
				mockRequests: 1,
				mockPath: "www.example.com:1234"
			}
		});
	});

	it("provides default port", async () => {
		await requestAndVerify({
			agent: agent({}),
			mock: await startMockHttpProxy({ port }),
			requestOptions: { port: undefined },
			expectations: {
				mockPath: "www.example.com:443"
			}
		});
	});

	it("uses hostname to avoid duplicating port", async () => {
		await requestAndVerify({
			agent: agent({
				proxyRequestOptions: { hostname: "localhost", host: "localhost:" + port }
			}),
			mock: await startMockHttpProxy({ port }),
			requestOptions: { hostname: "www.example.com", host: "www.example.com:1234" },
			expectations: {
				responseData: "Success",
				mockConnections: 1,
				mockRequests: 1,
				mockPath: "www.example.com:1234"
			}
		});
	});

	it("propagates connect error", async () => {
		await requestAndVerify({
			agent: agent({}),
			mock: await startMockHttpProxy({
				port,
				failConnect: true
			}),
			expectations: {
				responseErrorMessage: "Connection Error",
				responseErrorCode: 500
			}
		});
	});

	it("pools connections", async () => {
		const mock = await startMockHttpProxy({
			port,
			keepAlive: true
		});
		const options = {
			agent: agent({
				httpsAgentOptions: { maxSockets: 1 }
			}),
			mock,
			expectations: {
				responseData: "Success",
				mockConnections: 1
			}
		};
		const results = [
			requestAndVerify(options),
			requestAndVerify(options),
			requestAndVerify(options)
		];
		await Promise.all(results).then(() => {
			verifyMockExpectations(mock, {
				mockRequests: 3
			});
		});
	});

	it("establishes new connections when proxy closes them", async () => {
		const mock = await startMockHttpProxy({
			port
		});
		const options = {
			agent: agent({
				httpsAgentOptions: { maxSockets: 1 }
			}),
			mock,
			expectations: {
				responseData: "Success"
			}
		};
		await requestAndVerify(options);
		await requestAndVerify(options);
		verifyMockExpectations(mock, {
			mockConnections: 2,
			mockRequests: 2
		});
	});

	it("supports timeout handlers on slow connect", async () => {
		const mock = await startMockHttpProxy({
			port,
			hangConnect: 50,
			keepAlive: true
		});
		let timedOut = 0;
		const options = {
			agent: agent({}),
			mock,
			requestOptions: {
				timeout: 20,
				onTimeout: () => timedOut++,
			},
			expectations: {
				responseData: "Success"
			}
		};
		await requestAndVerify(options);
		expect(timedOut).to.equal(1);
	});

	it("supports destroy during slow connect", async () => {
		const mock = await startMockHttpProxy({
			port,
			hangConnect: true,
			keepAlive: true
		});
		const options = {
			agent: agent({}),
			mock,
			requestOptions: {
				timeout: 20,
				onTimeout: function() { this.abort() }
			},
			expectations: {
				// This is the documented error message if you abort a request before it connects
				responseErrorMessage: "socket hang up"
			}
		};
		await requestAndVerify(options);
	});

	it("supports timeout handlers on slow request", async () => {
		const mock = await startMockHttpProxy({
			port,
			hangRequest: 50,
			keepAlive: true
		});
		let timedOut = 0;
		const options = {
			agent: agent({
				httpsAgentOptions: { maxSockets: 1 }
			}),
			mock,
			requestOptions: {
				timeout: 20,
				onTimeout: () => timedOut++,
			}
		};
		await requestAndVerify(options);
		await requestAndVerify(options);
		expect(timedOut).to.equal(2);
	});

	it("clears timeout handlers", async () => {
		const mock = await startMockHttpProxy({
			port,
			hangRequest: 50,
			keepAlive: true
		});
		let timedOut = 0;
		const options = {
			agent: agent({
				httpsAgentOptions: { maxSockets: 1 }
			}),
			mock,
			requestOptions: {
				timeout: 100,
				onTimeout: () => timedOut++
			}
		};
		await requestAndVerify(options);
		options.requestOptions.timeout = 20;
		await requestAndVerify(options);
		expect(timedOut).to.equal(1);
	});

	it("doesn't leak memory", async function () {
		/*
		 * Increase the timeout for the test as we're firing off a lot of requests
		 * sequentially for this test.
		 */
		this.timeout(5000);

		const mock = await startMockHttpProxy({
			port,
			keepAlive: true
		});

		/*
		 * This isn't specifically testing timeouts, but timeout handlers were causing
		 * a memory leak, so they're here in order to reproduce the problem.
		 */
		let timedOut = false;
		const options = {
			agent: agent({
				httpsAgentOptions: { maxSockets: 1 }
			}),
			mock,
			requestOptions: {
				timeout: 1000,
				onTimeout: () => timedOut = true,
			},
			expectations: {
				responseData: "Success",
				mockConnections: 1
			}
		};

		// Warm up
		for (let i=0; i<100; i++) {
			await requestAndVerify(options);
		}

		// Measure memory increase
		global.gc();
		const initialMemory = process.memoryUsage().heapTotal;
		for (let j=0; j<2000; j++) {
			await requestAndVerify(options);
			if (j%100==99) global.gc();
		}
		const finalMemory = process.memoryUsage().heapTotal;
		const increasedMemory = finalMemory - initialMemory;

		/*
		 * I reliably see memory increase by at most 0.5 MB, but it's not an 
		 * exact science so this assertion is conservative. Prior to fixing the
		 * bug there were increases of around 25 MB.
		 */
		expect(increasedMemory).to.be.lessThan(2 * 1024 * 1024);
	});

});

function agent(options) {
	const httpsAgentOptions = Object.assign(
			defaultHttpsAgentOptions(), options.httpsAgentOptions || {});

	const proxyRequestOptions = Object.assign(
			defaultProxyRequestOptions(), options.proxyRequestOptions || {});

	return new Agent(httpsAgentOptions, proxyRequestOptions);
}

function defaultHttpsAgentOptions() {
	return {
		keepAlive: true
	};
}

function defaultProxyRequestOptions() {
	return {
		protocol: "http:", 
		host: "localhost",
		port,
		timeout: 5000,
		maxSockets: 100
	};
}

async function requestAndVerify(options) {
	if (!options.agent) {
		throw new Error("agent not provided");
	}

	if (!options.mock) {
		throw new Error("mock not provided");
	}

	const requestOptions = Object.assign(
			await defaultRequestOptions(options.agent), options.requestOptions || {});

	const response = await performRequest(requestOptions);
	verifyResponseExpectations(response, options.expectations || {});
	verifyMockExpectations(options.mock, options.expectations || {});
}

function defaultRequestOptions(agent) {
	return Promise.all([
		readFile(__dirname + "/example.crt.pem"),
		readFile(__dirname + "/example.crt.pem"),
		readFile(__dirname + "/example.key.pem")
	]).then(([ca, cert, key]) => {
		return {
			protocol: "https:",
			host: "www.example.com",
			port: 1234,
			agent,
			ca,
			cert,
			key
		};
	});
}

function performRequest(requestOptions) {
	const request = https.request(requestOptions);
	const timeout = requestOptions.timeout;
	const onTimeout = requestOptions.onTimeout;
	if (onTimeout) {
		delete requestOptions.timeout;
		delete requestOptions.onTimeout;
	}
	return new Promise((resolve, reject) => {
		request.on('error', (err) => {
			resolve({
				statusCode: null,
				data: null,
				error: err
			});
		});
		if (onTimeout) {
			request.setTimeout(timeout ? timeout : 1000, onTimeout.bind(request));
		}
		request.on('response', (response) => {
			response.data = "";
			response.on('data', (chunk) => {
				response.data += chunk.toString('utf8');
			});
			response.on('end', () => {
				response.error = null;
				resolve(response);
			});
			response.on('error', (err) => {
				response.error = err;
				resolve(response);
			});
		});
		request.end();
	});
}

function verifyResponseExpectations(response, expectations) {
	if (expectations.responseErrorMessage) {
		expect(response.error.message).to.contain(expectations.responseErrorMessage);
	}
	if (expectations.responseErrorCode) {
		expect(response.error.code).to.equal(expectations.responseErrorCode);
	}
	if (expectations.responseData) {
		expect(response.data).to.contain(expectations.responseData);
	}
}

function verifyMockExpectations(mock, expectations) {
	if (expectations.mockConnections) {
		expect(mock.connections.length).to.equal(expectations.mockConnections);
	}
	if (expectations.mockRequests) {
		expect(mock.requests).to.equal(expectations.mockRequests);
	}
	if (expectations.mockPath) {
		expect(mock.connections[mock.connections.length-1]).to.equal(expectations.mockPath);
	}
}
