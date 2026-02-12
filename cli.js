#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".claudeboard.json",
);

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { projects: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

const [command, ...args] = process.argv.slice(2);

if (command === "add") {
  const target = args[0] || process.cwd();
  const resolved = path.resolve(target);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`Not a directory: ${resolved}`);
    process.exit(1);
  }

  const data = loadData();
  if (!data.projects) data.projects = [];

  if (!data.projects.includes(resolved)) {
    data.projects.push(resolved);
    saveData(data);
  }

  console.log(`Tracking: ${resolved}`);
} else {
  console.log("Usage: claudeboard add [path]");
  console.log("  path defaults to current directory");
}
