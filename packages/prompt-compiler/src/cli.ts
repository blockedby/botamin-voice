#!/usr/bin/env bun
import { compilePromptBundle } from "./index.js";

interface CliOptions {
	sourceRoot: string;
	runtimeDir: string;
}

function usage(): string {
	return "Usage: prompt-compiler [--source-root PATH] [--runtime-dir PATH]";
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		sourceRoot: process.cwd(),
		runtimeDir: "/app/runtime-brain",
	};

	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (flag === "--help") {
			process.stdout.write(`${usage()}\n`);
			process.exit(0);
		}
		if (flag !== "--source-root" && flag !== "--runtime-dir") {
			throw new Error(`unknown argument: ${flag ?? ""}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`missing value for ${flag}`);
		if (flag === "--source-root") options.sourceRoot = value;
		else options.runtimeDir = value;
		index += 1;
	}

	return options;
}

try {
	const metadata = await compilePromptBundle(parseArgs(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(metadata)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n${usage()}\n`);
	process.exitCode = 1;
}
