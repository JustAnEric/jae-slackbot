#!/usr/bin/env node
// A SIMPLE SETUP SCRIPT FOR JAE EXEC SERVER!

const fs = require("fs/promises");
const path = require("path");

const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const ENV_PATH = path.join(__dirname, '.env');
const rl = readline.createInterface({ input, output });

async function fileExists(path) {
    try {
        await fs.access(path, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function parseEnv(envString) {
    const config = {};
    const lines = envString.split('\n');

    for (const line of lines) {
        if (!line || line.trim().startsWith('#')) continue;

        const firstEquals = line.indexOf('=');
        if (firstEquals === -1) continue;

        const key = line.substring(0, firstEquals).trim();
        let value = line.substring(firstEquals + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        config[key] = value;
    }
    return config;
}

function stringifyEnv(configObject) {
    const lines = [`# Updated on ${new Date().toISOString()}`];

    for (const [key, value] of Object.entries(configObject)) {
        if (isNaN(value) || value.includes(' ')) {
            lines.push(`${key}="${value}"`);
        } else {
            lines.push(`${key}=${value}`);
        }
    }

    lines.push('');
    return lines.join('\n');
}

async function runSetupRoutine() {
    console.log('FIRST-TIME ENV SETUP');
    console.log('No .env file found. Let\'s set it up.\n');

    const executionServerToken = `jae_${crypto.randomUUID()}.${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const port = await rl.question('PORT (default 6200): ') || '6200';
    const host = await rl.question('HOST (default 0.0.0.0): ') || '0.0.0.0';

    const initialConfig = { EXECUTION_SERVER_TOKEN: executionServerToken, EXECUTION_SERVER_PORT: port, EXECUTION_SERVER_HOST: host };
    await fs.writeFile(ENV_PATH, stringifyEnv(initialConfig), 'utf8');

    console.log('\nSetup complete! Created .env');
    await rl.question('\nPress Enter to launch the main menu...');
}

async function runInteractiveEditor() {
    console.log('INTERACTIVE .ENV EDITOR');
    console.log('Press [Enter] to keep the current value, or type a new one.\n');

    const rawEnvContent = await fs.readFile(ENV_PATH, 'utf8');
    const currentConfig = parseEnv(rawEnvContent);
    const updatedConfig = {};

    for (const key of Object.keys(currentConfig)) {
        const currentValue = currentConfig[key];
        const newValue = await rl.question(`${key} [current: ${currentValue}]: `);

        updatedConfig[key] = newValue.trim() !== '' ? newValue.trim() : currentValue;
    }

    await fs.writeFile(ENV_PATH, stringifyEnv(updatedConfig), 'utf8');

    console.log('\nChanges saved successfully to .env!');
    await rl.question('\nPress Enter to return to the setup menu...');
}

async function runMainMenu() {
    let keepRunning = true;

    while (keepRunning) {
        const rawEnvContent = await fs.readFile(ENV_PATH, 'utf8');
        const config = parseEnv(rawEnvContent);

        console.log(`=== JAE EXECUTION SERVER CONFIG ===`);
        console.log(`Status: Running on port ${config.EXECUTION_SERVER_PORT || 'unknown'}`);
        console.log('=================================');
        console.log('1. View Raw .env Content');
        console.log('2. Edit Environment Variables');
        console.log('3. Exit');
        console.log('=================================');

        const choice = await rl.question('Choose an option (1-3): ');

        switch (choice.trim()) {
            case '1':
                console.log('\nCurrent .env file contents:');
                console.log('---------------------------------');
                console.log(rawEnvContent.trim());
                console.log('---------------------------------');
                await rl.question('\nPress Enter to return to menu...');
                break;

            case '2':
                await runInteractiveEditor();
                break;

            case '3':
                console.log('\nGoodbye!');
                keepRunning = false;
                break;

            default:
                console.log('\nInvalid option.');
                await rl.question('\nPress Enter to try again...');
                break;
        }
    }
}

async function main() {
    try {
        const isConfigured = await fileExists(ENV_PATH);

        if (!isConfigured) {
            await runSetupRoutine();
        }

        await runMainMenu();
    } catch (error) {
        console.error('An error occurred:', error.message);
    } finally {
        rl.close();
    }
}

main();