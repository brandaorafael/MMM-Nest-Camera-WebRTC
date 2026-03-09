#!/usr/bin/env node
/**
 * Exchange Nest OAuth authorization code for access and refresh tokens.
 * Saves tokens to tokens.json in this module directory.
 *
 * Usage:
 *   node modules/MMM-Nest-Camera-WebRTC/exchange-nest-code.js              # uses nestCode from config
 *   node modules/MMM-Nest-Camera-WebRTC/exchange-nest-code.js "4/0AfrIepC..."  # uses code from CLI arg
 */

const fs = require("fs");
const path = require("path");

const MODULE_DIR = __dirname;
const ROOT = path.join(MODULE_DIR, "..", "..");
const CONFIG_PATH = path.join(ROOT, "config", "config.js");
const TOKENS_PATH = path.join(MODULE_DIR, "tokens.json");

function loadNestConfig() {
	const config = require(CONFIG_PATH);
	const module = config.modules?.find((m) => m.module === "MMM-Nest-Camera-WebRTC");
	return module?.config;
}

function getNestCode() {
	const codeArg = process.argv[2];
	if (codeArg) return codeArg.trim();
	const nestConfig = loadNestConfig();
	return nestConfig?.nestCode?.trim() || "";
}

async function exchangeCode(clientId, clientSecret, code) {
	const url = `https://www.googleapis.com/oauth2/v4/token?client_id=${clientId}&client_secret=${clientSecret}&code=${code}&grant_type=authorization_code&redirect_uri=https://www.google.com`;
	const response = await fetch(url, {
		headers: { "Content-Type": "application/json" },
		method: "POST"
	});
	const data = await response.json();
	if (!response.ok || data.error) {
		const msg = data.error_description || data.error || JSON.stringify(data);
		throw new Error(msg + (data.error === "invalid_grant" ? " (code may be expired or already used)" : ""));
	}
	return data;
}

async function main() {
	const nestConfig = loadNestConfig();
	if (!nestConfig || !nestConfig.nestClientId || !nestConfig.nestClientSecret) {
		process.exit(0); // Nest module not configured; skip silently
	}
	const { nestClientId, nestClientSecret } = nestConfig;

	const code = getNestCode();
	if (!code) {
		process.exit(0); // No code to exchange; skip silently (tokens may already exist)
	}

	try {
		const tokens = await exchangeCode(nestClientId, nestClientSecret, code);
		const toSave = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token || null
		};
		fs.writeFileSync(TOKENS_PATH, JSON.stringify(toSave, null, 2), "utf8");
		console.log("Tokens saved to", TOKENS_PATH);
		console.log("Access token:", tokens.access_token ? "OK" : "missing");
		console.log("Refresh token:", tokens.refresh_token ? "OK" : "missing (re-auth with access_type=offline&prompt=consent)");
	} catch (err) {
		console.error("Exchange failed:", err.message);
		process.exit(1);
	}
}

main();
