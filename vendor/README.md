# vendor

Building Clip Tool from source needs the **Ableton Extensions SDK** (currently a
beta, distributed by Ableton through their Centercode beta programme). It isn't
on npm and can't be redistributed here, so you supply your own copy.

Drop these two files from the SDK package into this folder:

```
vendor/ableton-extensions-sdk-1.0.0-beta.0.tgz
vendor/ableton-extensions-cli-1.0.0-beta.0.tgz
```

Then run `npm install` from the project root. The `.tgz` files are gitignored,
so they stay on your machine and never get committed.

You only need this to build from source. If you just want to use Clip Tool,
grab the prebuilt `.ablx` from the [Releases](../../releases) page instead.
