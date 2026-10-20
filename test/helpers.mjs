/** Shared fixtures for the proxy tests (no framework magic, just servers). */
import { createServer, request as httpRequest } from "node:http";

export function fakeWebServer() {
	const routes = [];
	const upgrades = [];
	const server = createServer((req, res) => {
		for (const route of routes) {
			if (req.url.startsWith(route.path)) { route.handler(req, res); return; }
		}
		res.writeHead(404).end();
	});
	server.on("upgrade", (req, socket, head) => {
		for (const route of upgrades) {
			if (req.url.split("?")[0] === route.path) { route.handler(req, socket, head); return; }
		}
		socket.destroy();
	});
	return {
		server,
		register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; },
		registerUpgrade: (route) => { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1); }; },
	};
}

export const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

export const close = (server) => new Promise((resolve) => {
	server.closeAllConnections?.();
	server.close(() => resolve());
});

export function get(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { headers, agent: false }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
}
