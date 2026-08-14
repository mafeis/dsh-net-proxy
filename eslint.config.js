// eslint flat config —— dsh-net-proxy 门禁：兜语法/明显错误，不做风格洁癖。
// 适配：私有 @deepseek-ai/* peer（CI 用 --legacy-peer-deps 安装）与 手写 UMD 的 lib/client.js。
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: ["node_modules/**", "dist/**", "build/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 门禁只拦明显错误；风格类不设噪音，保证现有手写代码零 error 通过
      "no-unused-vars": "off",
      "no-empty": "off",
      "no-constant-condition": "off",
      "no-useless-escape": "off",
      "no-async-promise-executor": "off", // 既有 `new Promise(async ...)` 隧道协商模式，行为稳定
    },
  },
  {
    // 手写 UMD 浏览器 bundle（CommonJS 形态 + 浏览器/加载器全局）
    files: ["lib/client.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        window: "readonly",
        document: "readonly",
        module: "readonly",
        exports: "writable",
        require: "readonly",
      },
    },
  },
];
