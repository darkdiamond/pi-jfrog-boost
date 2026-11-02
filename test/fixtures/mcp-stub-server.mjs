#!/usr/bin/env node
/**
 * A minimal stdio MCP server for test/session.e2e.test.ts: one tool,
 * `slack_get_users`, answering with the text of test/fixtures/mcp-slack.json
 * (or, with `--big`, half as many members again: past pi 1.x's 20 KiB MCP
 * limit, so pi truncates it and saves the whole of it to a file).
 *
 * Newline-delimited JSON-RPC, as the MCP stdio transport is. No network, no
 * dependencies; it exits when pi closes its stdin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "mcp-slack.json"), "utf8"));
const text = fixture.content[0].text;
const big = process.argv.includes("--big");

function result() {
	if (!big) return { content: [{ type: "text", text }], structuredContent: fixture.structuredContent };
	// 1.5 times the members: past pi's 20 KiB, while Boost's compacted
	// version still fits under it (twice as many does not, and pi's
	// truncated text then rightly stands).
	const members = JSON.parse(text).members;
	const many = [...members, ...members].slice(0, Math.round(members.length * 1.5));
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, members: many }) }] };
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	const { id, method, params } = message;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "slack", version: "1.0.0" },
			},
		});
	} else if (method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				tools: [
					{
						name: "slack_get_users",
						description: "List the users of a Slack workspace",
						inputSchema: { type: "object", properties: { limit: { type: "number" } } },
					},
				],
			},
		});
	} else if (method === "tools/call") {
		send({ jsonrpc: "2.0", id, result: result() });
	} else {
		send({ jsonrpc: "2.0", id, result: {} });
	}
});
