/**
 * Privacy gate for everything that ships.
 *
 * The repository must never carry a user's real infrastructure or task data:
 * public IPs, real hostnames, SSH targets, tokens, absolute home paths, or
 * screenshots of a live environment (images are checked by a human — this
 * script covers text).
 *
 * Scope: every tracked file. The allowlist is deliberately small and explicit
 * — documentation IP ranges, loopback/private ranges used by tests, example
 * domains. When a new example is needed, add it here *with a comment saying
 * why it is not real*.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([".md", ".js", ".mjs", ".yml", ".yaml", ".json", ".sh", ".txt", ".svg", ".html"]);

/** Authoritative "this is an example" lists. Keep small, keep commented. */
const ALLOWED_IPS = [
	/^127\./,                    // loopback (tests, local endpoints)
	/^10\./,                     // RFC1918 examples in tests
	/^192\.168\./,
	/^172\.(1[6-9]|2[0-9]|3[01])\./,
	/^203\.0\.113\./,            // TEST-NET-3, documentation
	/^198\.51\.100\./,           // TEST-NET-2, documentation
	/^192\.0\.2\./,              // TEST-NET-1, documentation
	/^0\./,
	/^255\./,
];
/** Real-looking IPs that are still obviously fake examples in prose. */
const ALLOWED_IP_LITERALS = new Set(["1.2.3.4", "0.0.0.0", "255.255.255.255"]);

const FORBIDDEN = [
	{ id: "public IPv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, check: (match) => {
		if (ALLOWED_IP_LITERALS.has(match)) return false;
		return !ALLOWED_IPS.some((allowed) => allowed.test(match));
	} },
	{ id: "home directory path", pattern: /\/Users\/[A-Za-z][\w.-]*/g },
	{ id: "remote dsh data path", pattern: /\/data\/dsh\//g },
	// Test fixtures use a deliberately fake token; anything 40+ chars is real-shaped.
	{ id: "token in URL", pattern: /[?&]token=[A-Za-z0-9_-]{40,}/g },
	{ id: "bearer/basic credential", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{20,}/g },
	{ id: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Domains that belong to the user's infrastructure, if any were ever added. */
const DENY_DOMAINS = ["example.com"];

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)
	.filter((file) => TEXT_EXTENSIONS.has(extname(file)));

const findings = [];
for (const file of files) {
	let text;
	try {
		text = readFileSync(join(root, file), "utf8");
	} catch {
		continue;
	}
	const lines = text.split("\n");
	for (const rule of FORBIDDEN) {
		rule.pattern.lastIndex = 0;
		for (const match of text.matchAll(rule.pattern)) {
			const value = match[0];
			if (typeof rule.check === "function" && !rule.check(value)) continue;
			findings.push({ file, rule: rule.id, value });
		}
	}
	for (const domain of DENY_DOMAINS) {
		if (text.includes(domain)) findings.push({ file, rule: "denied domain", value: domain });
	}
	// A bare "user@host" pair looks like an SSH target — unless the host is a
	// documentation/private literal or an obviously fake name used in tests.
	for (const match of text.matchAll(/\b(?:root|admin|ubuntu|deploy)@([a-z0-9][a-z0-9.-]{2,})/gi)) {
		const host = match[1];
		const fake = ALLOWED_IPS.some((allowed) => allowed.test(host))
			|| ALLOWED_IP_LITERALS.has(host)
			|| /\.(internal|example|test|invalid|localhost)$/.test(host)
			|| host === "h" || host === "host";
		if (!fake) findings.push({ file, rule: "ssh target", value: match[0] });
	}
	void lines;
}

if (findings.length > 0) {
	console.error("privacy: found content that must not ship:");
	for (const item of findings.slice(0, 40)) {
		console.error(`  ${item.file}: ${item.rule} → ${JSON.stringify(item.value).slice(0, 80)}`);
	}
	if (findings.length > 40) console.error(`  … and ${findings.length - 40} more`);
	console.error("privacy: replace with documentation values (203.0.113.x, example.com, <token>, /home/user).");
	process.exit(1);
}
console.log(`privacy: ${files.length} tracked text files clean`);
