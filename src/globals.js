const { Ollama } = require("ollama");
const path = require("path");
const fs = require("fs");

module.exports = {
    ollama: new Ollama({ host: process.env.OLLAMA_HOST }),
    path: path, fs: fs
};