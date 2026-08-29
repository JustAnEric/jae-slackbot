import { Ollama } from "ollama";
import path from "path";
import fs from "fs";

let ollama;

if (process.env.OLLAMA_HOST) {
    ollama = new Ollama({ host: process.env.OLLAMA_HOST });
}

export default {
    ollama,
    path, fs
};