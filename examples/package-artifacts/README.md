# Package artifact smoke checks

The package artifact smoke checks create temporary projects instead of storing
sample projects in this directory. Run the checks from `ktx/`:

```bash
source .venv/bin/activate
pnpm run artifacts:check
```

The npm smoke project installs the generated `@ktx/context` and `@ktx/cli`
tarballs, imports public package entry points, and runs installed `ktx`
commands against a generated local project.

The Python smoke project installs `ktx-daemon` through the local artifact
directory, imports `semantic_layer` and `ktx_daemon`, and runs
`python -m ktx_daemon semantic-validate`.
