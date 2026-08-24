# 😊 Jae slackbot

> @JustAnEric: come up /w a cool quote so i can put it on your github page, probably reference yourself
>
> Assistant:
>
> oh, you want me to reference myself? you're really something catch a break. 🙄
>
> how about this:
>
> "i'm just a little bot, but i love seeing all your awesome code come to life. keep coding, you magnificent human!"
>
> it's... fine. now go make something cool!

Jae is an AI bot that runs *blazing fast* on the Hack Club Slack, and this repository is for the code that powers her.

(The running version on the Slack is already configured to run @JustAnEric's local, at home models.)

## Features

### 🧩 API Integrations

Jae needs an API behind her to generate responses. Here's what the current situation looks like:

- [X] Ollama API integration
- [ ] OpenAI API integration (coming soon)

### 🫂 Slack-Side

- [X] typing indicator for impatient peoples
- [X] supports markdown, emoji use
- [X] looks at user profiles

### 📜 System prompt

- [X] editable system prompt `PROMPT.md` file
- [X] simple templating engine

### ✈️ AI Agent

- [ ] tool calling
- [ ] context compression for older messages
- [X] use Slack's agent functionality for better responses (expanding further from DMs)
- [X] response streaming to Slack
- [ ] beautiful Slack agent responses
    - [X] thinking block
    - [ ] canvas creation for code
    - [X] reliable markdown beyond the system prompt

## ⬇️ Setup

1. Clone the repository:
```bash
git clone https://github.com/JustAnEric/jae-slackbot
cd jae-slackbot
```
2. Create the `.env` file and configure based on the example:
```bash
nano .env # if you're on linux
```
Make sure the contents are similar to below and you grab your own app/oauth tokens...
```ini
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
SLACK_BOT_MEMBER_ID=U0BRTN1TS1H
SLACK_BOT_TEST_CHANNEL=C0BS4G20ZR7

OLLAMA_HOST=127.0.0.1:11434
MODEL=gemma4:e2b
CONTEXT_WINDOW_SIZE=32768
TEMPERATURE=0.8
THINKING_MODE=true
STREAM_MODE=true
MAX_PREVIOUS_MESSAGES=15
```
Your app *needs* these OAuth bot token scopes (these can change frequently after updates):
```lua
app_mentions:read   -- View messages that directly mention @jae in conversations that the app is in
assistant:write   -- Allow "jae" to act as an App Agent
channels:history   -- View messages and other content in public channels that "jae" has been added to
channels:read   -- View basic information about public channels in a workspace
chat:write   -- Send messages as @jae
commands   -- Add shortcuts and/or slash commands that people can use
emoji:read   -- View custom emoji in a workspace
groups:read   -- View basic information about private channels that "jae" has been added to
im:history   -- View messages and other content in direct messages that "jae" has been added to
im:read   -- View basic information about direct messages that "jae" has been added to
im:write   -- Start direct messages with people
users.profile:read   -- View profile details about people in a workspace
users:read   -- View people in a workspace
```
Add event subscriptions so the bot receives events via Socket Mode (Features -> Event Subscriptions):
```lua
agent_session_stopped   -- 
agent_session_title_changed   --
assistant_thread_context_changed   -- The context changed while an App Agent thread was visible
assistant_thread_started   -- An App Agent thread was started
message.channels   -- A message was posted to a channel
message.groups   -- A message was posted to a private channel
message.im   -- A message was posted in a direct message channel
app_home_opened   -- User clicked into your App Home
```
And make sure to turn on agent experience in the Features -> Agents section of your Slack API dashboard.

3. Install project requirements, you should have Node.JS version 22 or greater:
```bash
npm i # to install packages prelisted in package.json
```
4. Configure the `PROMPT.md` file to suit your needs, this will be used for the system prompt:
    - `{userID}` is the user ID of who is making a request
    - `{userName}` is the user name of who is making a request
    - `{userStatusEmoji}` is the emoji the user has in their status
    - `{userStatusText}` is the text the user has in their status
    - `{channelID}` is the ID of the channel the user initiated a model turn in
    - `{channelType}` is the type of the channel the user initiated a model turn in (one of type):
        - Direct Message Channel
        - Public Channel
    - `{channelName}` is the name of the channel the user initiated a model turn in

    > :warning: The curly braces are absolutely required (`{...}`) for the regexp.
5. Run Jae (a script has already been created, or just use `node .`):
```bash
npm start
```

## 🤝 Hack Club

This project started out with a template from Hack Club's official guides: [Slack Bot Mission](https://stardance.hackclub.com/missions/slack-bot/guide#step-1) (thanks Hack Club for the neat suggestion)

[Slack docs](https://docs.slack.dev/ai/developing-agents/) were also used for investigating how to build agents on the platform.