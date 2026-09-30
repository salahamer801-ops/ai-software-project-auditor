import type { SnapshotSource } from "../sources/snapshot";
import { snapshotFromRawFiles } from "../sources/snapshot";
import type { RepoSnapshot } from "../types";

/**
 * Golden dataset (spec §45): a small project that deliberately contains the issues the
 * platform claims to find. It is used by the "demo repository" button and by the engine
 * self-tests, so every claim in the UI can be reproduced without uploading anything.
 *
 * The values below are obvious placeholders, and the pipeline masks them like any other
 * detected secret.
 */

const FILES: { path: string; content: string }[] = [
  {
    path: "README.md",
    content: `# Shop Platform (demo fixture)

A small Node/Express service used to demonstrate CodeAudit. Every problem in this
repository is intentional: exposed secrets, an injectable query, a missing authorisation
check, vulnerable dependencies, circular imports, duplicated code and an incomplete test
suite.
`,
  },
  {
    path: "package.json",
    content: `{
  "name": "shop-platform-demo",
  "version": "0.4.1",
  "private": true,
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "4.16.0",
    "lodash": "4.17.11",
    "minimist": "0.0.8",
    "axios": "0.21.1",
    "jsonwebtoken": "8.5.1",
    "mysql": "2.18.1",
    "multer": "1.4.2",
    "yaml": "^2.0.0",
    "pg": "latest"
  },
  "devDependencies": {
    "jest": "26.6.0"
  }
}
`,
  },
  {
    path: ".env",
    content: `APP_ENV=production
APP_DEBUG=true
STRIPE_SECRET_KEY=sk_live_EXAMPLEDEMO0000000000000000001234
DATABASE_URL=postgres://shop_admin:SuperSecret123@db.internal:5432/shop
JWT_SECRET=jwt-demo-signing-key-do-not-use-abcdef123456
SMTP_PASSWORD=mail-password-demo
`,
  },
  {
    path: "src/config.js",
    content: `'use strict';

const config = {
  port: 8080,
  debug: true,
  stripeKey: 'sk_live_EXAMPLEDEMO0000000000000000001234',
  jwtSecret: 'jwt-demo-signing-key-do-not-use-abcdef123456',
  db: {
    host: 'db.internal',
    user: 'shop_admin',
    password: 'SuperSecret123',
    database: 'shop',
  },
};

module.exports = config;
`,
  },
  {
    path: "src/db.js",
    content: `'use strict';

const mysql = require('mysql');
const config = require('./config');

const pool = mysql.createPool({
  connectionString: 'postgres://shop_admin:SuperSecret123@db.internal:5432/shop',
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

function findUser(email) {
  return new Promise((resolve, reject) => {
    const sql = 'SELECT * FROM users WHERE email = ' + JSON.stringify(email);
    pool.query(sql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows[0]);
    });
  });
}

function findByEmail(email) {
  return new Promise((resolve, reject) => {
    pool.query('select * from users where email = ' + email, (err, rows) => {
      if (err) reject(err);
      else resolve(rows[0]);
    });
  });
}

module.exports = { pool, findUser, findByEmail };
`,
  },
  {
    path: "src/auth.js",
    content: `'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { findByEmail } = require('./db');

function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

function createResetToken() {
  return Math.random().toString(36).slice(2);
}

function login(email, password) {
  try {
    const user = findByEmail(email);
    if (!user) {
      return null;
    }
    if (user.password_hash !== hashPassword(password)) {
      return null;
    }
    return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '30d' });
  } catch (e) {
  }
}

function storeSession(token) {
  localStorage.setItem('auth_token', token);
}

module.exports = { hashPassword, createResetToken, login, storeSession };
`,
  },
  {
    path: "src/users.routes.js",
    content: `'use strict';

const express = require('express');
const router = express.Router();
const { pool, findUser } = require('./db');

router.post('/users', (req, res) => {
  const body = req.body;
  pool.query(
    'INSERT INTO users (email, password_hash, role) VALUES (' +
      pool.escape(body.email) +
      ", '" +
      body.password +
      "', '" +
      body.role +
      "')",
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    },
  );
});

router.get('/users/:id', (req, res) => {
  pool.query('SELECT * FROM users WHERE id = ' + req.params.id, (err, rows) => {
    if (err) return res.status(500).send(err.stack);
    res.json(rows[0]);
  });
});

router.get('/users', (req, res) => {
  pool.query('select * from users', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.delete('/users/:id', (req, res) => {
  pool.query('DELETE FROM users WHERE id = ' + req.params.id, () => {
    res.json({ ok: true });
  });
});

module.exports = router;
`,
  },
  {
    path: "src/upload.js",
    content: `'use strict';

const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: '/tmp/uploads' });

function saveAvatar(req, res) {
  const target = '/var/www/uploads/' + req.body.filename;
  fs.readFile(target, 'utf8', (err, data) => {
    if (err) return res.status(500).send(err.message);
    res.send(data);
  });
}

function handleUpload(req, res) {
  res.json({ file: req.file.originalname, url: req.file.path });
}

module.exports = { upload, saveAvatar, handleUpload };
`,
  },
  {
    path: "src/legacy.js",
    content: `'use strict';

const config = require('./config');
const { formatMoney } = require('./utils');

function applyDiscount(orderTotal, promoCode, userRole) {
  let total = orderTotal;
  if (promoCode) {
    if (promoCode === 'SAVE10') {
      if (userRole === 'vip') {
        if (orderTotal > 100) {
          if (promoCode.length === 6) {
            if (orderTotal < 10000) {
              total = orderTotal - orderTotal * 0.1;
            }
          }
        }
      }
    }
  }
  if (promoCode === 'SAVE20') {
    total = orderTotal - orderTotal * 0.2;
  }
  if (promoCode === 'SAVE30') {
    total = orderTotal - orderTotal * 0.3;
  }
  if (promoCode === 'FREESHIP') {
    total = orderTotal;
  }
  if (promoCode === 'VIPONLY') {
    if (userRole === 'vip') {
      total = orderTotal - orderTotal * 0.15;
    }
  }
  if (promoCode === 'WELCOME') {
    total = orderTotal - 5;
  }
  if (total < 0) {
    total = 0;
  }
  return total;
}

function auditOrder(order) {
  const lines = [];
  lines.push('order:' + order.id);
  lines.push('total:' + order.total);
  lines.push('customer:' + order.customer_id);
  const summary = lines.join('|');
  return summary;
}

function auditOrderCopy(order) {
  const lines = [];
  lines.push('order:' + order.id);
  lines.push('total:' + order.total);
  lines.push('customer:' + order.customer_id);
  const summary = lines.join('|');
  return summary;
}

function runRule(code) {
  return eval(code);
}

function logCredentials(user) {
  console.log('login attempt for ' + user.email + ' with token ' + user.token + ' and password ' + user.password);
}

function describe(order) {
  const parts = [];
  for (const line of order.lines) {
    for (const option of line.options) {
      for (const modifier of option.modifiers) {
        for (const extra of modifier.extras) {
          for (const price of extra.prices) {
            if (price.currency === 'USD') {
              parts.push(price.amount);
            }
          }
        }
      }
    }
  }
  return parts.length + ' priced components';
}

module.exports = { applyDiscount, auditOrder, auditOrderCopy, runRule, logCredentials, describe, config };
`,
  },
  {
    path: "src/utils.js",
    content: `'use strict';

const axios = require('axios');
const { applyDiscount } = require('./legacy');

const client = axios.create({ timeout: 5000, rejectUnauthorized: false });

function formatMoney(amount, currency) {
  if (!amount) {
    return '0 ' + currency;
  }
  return amount.toFixed(2) + ' ' + currency;
}

function totalWithPromo(order, promoCode) {
  return applyDiscount(order.total, promoCode, order.role);
}

function fetchAvatar(url) {
  return client.get(url);
}

function parseSettings(raw) {
  const yaml = require('yaml');
  return yaml.load(raw);
}

module.exports = { formatMoney, totalWithPromo, fetchAvatar, parseSettings };
`,
  },
  {
    path: "src/slug.js",
    content: `'use strict';

// Small pure helper: the demo project's only module a self-contained test can import.
function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

function slugIsSafe(value) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

module.exports = { slugify, slugIsSafe };
`,
  },
  {
    path: "src/components/UserList.jsx",
    content: `import React, { useEffect, useState } from 'react';
import { pool } from '../db';

export default function UserList() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    pool.query('SELECT * FROM users', (err, rows) => {
      if (!err) setUsers(rows);
    });
  }, []);

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>
          <span dangerouslySetInnerHTML={{ __html: user.name }} />
        </li>
      ))}
    </ul>
  );
}
`,
  },
  {
    path: "src/reporting.js",
    content: `'use strict';

const { pool } = require('./db');

async function monthlyReport(accountIds) {
  const results = [];
  for (const accountId of accountIds) {
    const summary = await new Promise((resolve, reject) => {
      pool.query('SELECT * FROM invoices WHERE account_id = ' + accountId, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    results.push(summary);
  }
  return results;
}

function buildLine(order) {
  const lines = [];
  lines.push('order:' + order.id);
  lines.push('total:' + order.total);
  lines.push('customer:' + order.customer_id);
  return lines.join('|');
}

module.exports = { monthlyReport, buildLine };
`,
  },
  {
    path: "scripts/backup.py",
    content: `import os
import pickle
import subprocess

DB_PASSWORD = "SuperSecret123"
BACKUP_TOKEN = "ghp_EXAMPLEDEMO0000000000000000000000"

def run_backup(target):
    command = "pg_dump shop > " + target
    subprocess.call(command, shell=True)

def load_snapshot(path):
    with open(path, "rb") as handle:
        return pickle.loads(handle.read())

def restore(snapshot):
    try:
        os.system("pg_restore -d shop " + snapshot)
    except Exception:
        pass
`,
  },
  {
    path: "migrations/001_init.sql",
    content: `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) DEFAULT 'customer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  total NUMERIC(10, 2) NOT NULL,
  status VARCHAR(32) DEFAULT 'pending'
);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

DROP TABLE legacy_sessions;
`,
  },
  {
    path: "docker/Dockerfile",
    content: `FROM node:latest

WORKDIR /app
COPY . .

RUN curl -sSL https://example.com/install.sh | bash
RUN npm install

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
`,
  },
  {
    path: ".github/workflows/ci.yml",
    content: `name: ci
on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install
        run: npm install
      - name: Deploy
        env:
          API_TOKEN: ghp_EXAMPLEDEMO0000000000000000000000
          DB_PASSWORD: SuperSecret123
        run: |
          echo "deploying with token"
          ./scripts/deploy.sh
`,
  },
  {
    path: "config/private.pem",
    content: `-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAexamplekeyfordemo0000000000000000000000000000
DEMONSTRATIONONLYNOTAREALPRIVATEKEY00000000000000000000000000
-----END RSA PRIVATE KEY-----
`,
  },
  {
    path: "tests/users.test.js",
    content: `const { hashPassword } = require('../src/auth');

describe('auth', () => {
  it('hashes a password deterministically', () => {
    expect(hashPassword('secret')).toBe(hashPassword('secret'));
  });

  it.skip('rejects a wrong password', () => {
    expect(true).toBe(false);
  });
});
`,
  },
  {
    path: "tests/slug.test.js",
    content: `const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify, slugIsSafe } = require('../src/slug');

test('slugify lowercases and joins words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify keeps digits', () => {
  assert.equal(slugify('Order 42 report'), 'order-42-report');
});

test('a generated slug is safe to use in a URL', () => {
  const slug = slugify('  Pending Orders  ');
  assert.equal(slugIsSafe(slug), true, 'slug was not safe: ' + slug);
});
`,
  },
  {
    path: "test-results/junit.xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="shop-platform-demo" tests="187" failures="4" skipped="6" time="42.512">
  <testsuite name="tests/users.test.js" tests="187" failures="4" skipped="6" time="42.512">
    <testcase classname="auth" name="hashes a password deterministically" time="0.012"/>
    <testcase classname="auth" name="rejects a wrong password" time="0.004">
      <failure message="expect(received).toBe(expected)">Expected: false Received: true</failure>
    </testcase>
    <testcase classname="orders" name="applies SAVE10 for vip" time="0.02">
      <failure message="Expected total 90, received 100"/>
    </testcase>
    <testcase classname="orders" name="keeps totals above zero" time="0.01">
      <failure message="Expected 0, received -5"/>
    </testcase>
    <testcase classname="reporting" name="summarises invoices" time="0.03">
      <failure message="timeout of 5000ms exceeded"/>
    </testcase>
  </testsuite>
</testsuites>
`,
  },
  {
    path: "coverage/coverage-summary.json",
    content: `{
  "total": {
    "lines": { "total": 412, "covered": 169, "skipped": 0, "pct": 41.02 },
    "statements": { "total": 430, "covered": 178, "skipped": 0, "pct": 41.4 },
    "functions": { "total": 64, "covered": 21, "skipped": 0, "pct": 32.81 },
    "branches": { "total": 96, "covered": 26, "skipped": 0, "pct": 27.08 }
  }
}
`,
  },
];

export const DEMO_FILES = FILES;

export function demoSnapshot(): RepoSnapshot {
  const source: SnapshotSource = {
    type: "demo",
    label: "shop-platform-demo (intentionally flawed fixture)",
    repositoryUrl: "https://github.com/codeaudit/demo-shop-platform",
    owner: "codeaudit",
    repo: "demo-shop-platform",
    ref: "demo",
    commitSha: "demo000c0ffee0000000000000000000000000d",
  };
  return snapshotFromRawFiles(FILES, source);
}
