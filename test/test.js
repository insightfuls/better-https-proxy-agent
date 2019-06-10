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
	return new Promise((resolve, reject) => {
		request.on('error', (err) => {
			resolve({
				statusCode: null,
				data: null,
				error: err
			});
		});
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
	if (expectations.responseError) {
		expect(response.error.message).to.contain(expectations.responseError);
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
