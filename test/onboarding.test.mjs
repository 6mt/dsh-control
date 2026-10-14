/**
 * Host-side unit tests for the onboarding material (lib/onboarding.js).
 * Pure module: no runtime dependencies, so it runs under plain node --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	suggestName,
	buildTunnelCommand,
	buildRemoteParagraph,
	parseConnectBlock,
} from "../lib/onboarding.js";

test("suggestName derives a friendly name from the SSH address", () => {
	assert.equal(suggestName("root@203.0.113.10"), "203.0.113.10");
	assert.equal(suggestName("deploy@build-box.internal"), "build-box.internal");
	assert.equal(suggestName("user@host:2222"), "host");
	assert.equal(suggestName("just-a-host"), "just-a-host");
	assert.equal(suggestName(""), "remote");
	assert.equal(suggestName(undefined), "remote");
});

test("tunnel command carries the local port, remote port and target", () => {
	const command = buildTunnelCommand({ sshTarget: "root@10.0.0.5", localPort: 41001, remotePort: 3080 });
	assert.equal(command, "ssh -N -L 127.0.0.1:41001:127.0.0.1:3080 root@10.0.0.5");
});

test("remote paragraph is short, asks only for the token, and manages nothing remotely", () => {
	const paragraph = buildRemoteParagraph({ name: "build-box", localPort: 41001, remotePort: 3080 });
	// It must say how to obtain the token.
	assert.match(paragraph, /journalctl/);
	assert.match(paragraph, /```dshctl-token/);
	assert.doesNotMatch(paragraph, /dshctl-connect/, "the token is the whole protocol now");
	// Boundary: the plugin does not manage the remote machine's lifecycle —
	// no service deployment, no systemd or port instructions for the remote.
	assert.doesNotMatch(paragraph, /systemd/i, "do not lecture about keeping the remote running");
	assert.doesNotMatch(paragraph, /--profile web/, "do not deploy the remote from here");
	assert.doesNotMatch(paragraph, /0\.0\.0\.0/, "no remote binding advice");
	// Brevity is a product requirement: a glance, not an essay.
	const lines = paragraph.split("\n");
	assert.ok(lines.length <= 12, `paragraph should stay short, got ${lines.length} lines`);
});

test("parseConnectBlock accepts the minimal dshctl-token block", () => {
	const parsed = parseConnectBlock("```dshctl-token\nabcDEF1234567890_-xyzXYZ9876543210\n```", { name: "srv", localPort: 41001 });
	assert.equal(parsed.error, undefined);
	assert.equal(parsed.token, "abcDEF1234567890_-xyzXYZ9876543210");
	assert.equal(parsed.name, "srv");
	assert.equal(parsed.localPort, 41001);
});

test("parseConnectBlock reads the fenced block the remote agent prints", () => {
	const text = [
		"好的，已经准备好了：",
		"```dshctl-connect",
		"name: build-box",
		"endpoint: http://127.0.0.1:41001",
		"remote_port: 3080",
		"token: abcDEF1234567890_-xyzXYZ9876543210",
		"```",
	].join("\n");
	const parsed = parseConnectBlock(text, {});
	assert.equal(parsed.error, undefined);
	assert.equal(parsed.name, "build-box");
	assert.equal(parsed.endpoint, "http://127.0.0.1:41001");
	assert.equal(parsed.token, "abcDEF1234567890_-xyzXYZ9876543210");
	assert.equal(parsed.remotePort, 3080);
});

test("parseConnectBlock also accepts a bare token, a URL with token, or JSON", () => {
	const bare = parseConnectBlock("abcDEF1234567890_-xyzXYZ9876543210", { name: "srv" });
	assert.equal(bare.token, "abcDEF1234567890_-xyzXYZ9876543210");
	assert.equal(bare.name, "srv");

	const url = parseConnectBlock("http://127.0.0.1:3080/?token=abcDEF1234567890_-xyzXYZ9876543210", {});
	assert.equal(url.token, "abcDEF1234567890_-xyzXYZ9876543210");
	assert.equal(url.endpoint, "http://127.0.0.1:3080");

	const json = parseConnectBlock('{"name":"x","token":"abcDEF1234567890_-xyzXYZ9876543210"}', {});
	assert.equal(json.name, "x");
});

test("parseConnectBlock reports actionable errors instead of guessing", () => {
	assert.match(parseConnectBlock("", {}).error, /粘贴内容为空/);
	assert.match(parseConnectBlock("你好，我准备好了", {}).error, /没认出这段内容/);
	assert.match(
		parseConnectBlock("```dshctl-connect\nname: x\ntoken: <token>\n```", {}).error,
		/缺少有效的 token/,
		"an unfilled placeholder must not be accepted as a token",
	);
});

test("parseConnectBlock falls back to the wizard's own ports", () => {
	const parsed = parseConnectBlock("```dshctl-connect\ntoken: abcDEF1234567890_-xyzXYZ9876543210\n```", {
		name: "fallback",
		endpoint: "http://127.0.0.1:41234",
		localPort: 41234,
		remotePort: 3080,
	});
	assert.equal(parsed.name, "fallback");
	assert.equal(parsed.endpoint, "http://127.0.0.1:41234");
	assert.equal(parsed.localPort, 41234);
	assert.equal(parsed.remotePort, 3080);
});
