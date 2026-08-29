import globals from "./globals";

export default async () => {
    // on jae start

    const REQUIRED_SETTINGS : Array<[string, Function]> = [['MODEL',typecheck_string_no_default_ollama_model],['SLACK_BOT_TOKEN',typecheck_sc_bt_tk],['SLACK_APP_TOKEN',typecheck_sc_app_tk],['SLACK_BOT_MEMBER_ID',typecheck_sc_uid],['SLACK_BOT_TEST_CHANNEL',typecheck_sc_chid],['TOOLS_ENABLED',typecheck_bool]];

    //check all config
    const envConfigChecked: { [key: string]: string | undefined } = {};

    for (const [key, value] of Object.entries(process.env)) {
        const fOp = REQUIRED_SETTINGS.find(m=>m[0]==key);

        if (!fOp || fOp.length <= 1 || !fOp[1]) { continue };

        const res = await fOp[1](value);

        if (!res) {
            const db1 = get_ln_env(key);
            if (!db1) return verbose_error();
            return verbose_error(db1.linenum,db1.line);
        }

        envConfigChecked[key] = value;
    }

    console.log("all done!");
}

function typecheck_bool(a="") {
    a = a.trim().toLowerCase();
    return a == "false" || a == "true" ? true : false;
}

function typecheck_sc_bt_tk(a="") {
    return a.startsWith('xoxb-');
}

function typecheck_sc_app_tk(a="") {
    return a.startsWith('xapp-');
}

function typecheck_sc_uid(a="") {
    return a.startsWith('U') && a === a.toUpperCase();
}

function typecheck_sc_chid(a="") {
    return a.startsWith('C') && a === a.toUpperCase();
}

async function typecheck_string_no_default_ollama_model(a="") {
    // check if the model exists
    if (!globals.ollama) {
        console.warn("CRITICAL    Ollama is disabled!!");
        return false;
    }
    const { models } = await globals.ollama.list();
    let modelFound = false;
    for (const model of models) {
        if (model.name == a) {
            modelFound = true;
        }
    }
    if (!modelFound) {
        // if the model is not found, we can try to pull it from ollama.com
        console.log(`attempting to pull model '${a}' from ollama...`);

        const pp = await globals.ollama.pull({
            model: a,
            stream: true
        });

        if (pp) {
            console.log(`pulling model '${a}' from ollama...`);
            let lastpercent = 0;
            for await (const iter of pp) {
                if (lastpercent != Math.floor((iter.completed / iter.total) * 100)) {
                    lastpercent = Math.floor((iter.completed / iter.total) * 100);
                    render_progress_bar('downloading...',iter.completed,iter.total);
                }
            }
            process.stdout.write('\ndone!\n');
            return true;
        } else {
            console.log(`model '${a}' from ollama not able to be pulled...`);
            return false;
        }
    }
    return true;
}

function hlerr() {
    return console.error("---------------------------------------");
}

function get_ln_env(settingName="") {
    let envPath = globals.path.join(__dirname, '..', '.env');
    let fileContents = globals.fs.readFileSync(envPath, { encoding: 'utf8' });
    let linenum = 0;
    for (let line of fileContents.split("\n")) {
        linenum++;
        line = line.trim();
        if (!line || line.startsWith('#')) continue; //skip comments
        let [name, value] = line.split("=", 2);
        if (name == settingName) {
            return { linenum, line, name, value };
        }
    }
    return { linenum: null, line: null, name: settingName, value: null };
}

function verbose_error(linenum: number | undefined | null = null, line: string | undefined | null = null) {
    hlerr();
    if (linenum && line) {
        console.error("There was an error with validating configuration:");
        console.error(`| ${linenum}    ${line}`);
    } else {
        console.error(`There was an error with validating the configuration from ${globals.path.join(__dirname, '..', '.env')}!!`);
        console.error("| One or more required settings were missing/malformed.");
    }
    hlerr();
    process.exit(1);
}

function render_progress_bar(tt: string, current: number, total: number) {
    const size = 30;
    const percentage = Math.floor((current / total) * 100);
    const completedLength = Math.round((current / total) * size);
    const incompleteLength = size - completedLength;

    const completedBar = '='.repeat(completedLength);
    const incompleteBar = '-'.repeat(incompleteLength);
    
    if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`${tt} [${completedBar}${incompleteBar}] ${percentage}%`);
    } else {
        if (percentage % 10 == 0) process.stdout.write(`\n${tt} [${completedBar}${incompleteBar}] ${percentage}%`);
    }
}