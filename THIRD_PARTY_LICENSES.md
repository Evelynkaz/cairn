# Third-Party Licenses

Cairn is MIT-licensed. This file tracks the license of every runtime
dependency declared in `package.json`.

Per the [build brief](docs/BUILD_BRIEF.md), this project is intended to depend
only on permissively-licensed, header-only or npm-vendored libraries.

## Dependencies

### @modelcontextprotocol/sdk 1.30.0
- License: MIT
- Source: https://github.com/modelcontextprotocol/typescript-sdk

### sqlite-vec 0.1.9
- License: MIT OR Apache-2.0 (dual-licensed; the `sqlite-vec-<platform>`
  optional binaries pulled in by npm carry the same dual license)
- Source: https://github.com/asg017/sqlite-vec

### zod 3.25.76
- License: MIT
- Source: https://github.com/colinhacks/zod

### @huggingface/transformers (optional peer dependency, ^3)
- License: Apache-2.0
- Source: https://github.com/huggingface/transformers.js
- Not installed by default: this is an optional peer, only present on a
  machine that has opted into the local ONNX embedding runtime.

## Format

For each dependency, record:

```
### <package-name> <version>
- License: <SPDX identifier>
- Source: <upstream repository URL>
```
