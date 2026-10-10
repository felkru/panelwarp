#!/usr/bin/env python3
"""Generates media/settings-map.json: Warp setting storage key -> TOML path.

Web Warp stores settings in localStorage under each setting's storage key (its Rust type name
unless `storage_key:` overrides it, see crates/settings/src/macros.rs); desktop Warp's
settings.toml uses `toml_path`. The extension needs both to offer a real settings file.
Usage: gen-settings-map.py [warp source dir] (default ~/src/warp)
"""
import json, os, re, sys

src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/src/warp')
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'media', 'settings-map.json')
start = re.compile(r'\b[a-z_][a-z0-9_]*:\s*([A-Z][A-Za-z0-9]*)\s*\{')
enum_start = re.compile(r'implement_setting_for_enum!\(\s*([A-Z][A-Za-z0-9]*)\s*,')
mapping = {}
for root, _, files in os.walk(src):
    if '/target' in root or '/.git' in root:
        continue
    for name in files:
        if not name.endswith('.rs') or name.endswith('_tests.rs'):
            continue
        text = open(os.path.join(root, name), encoding='utf-8', errors='ignore').read()
        if 'toml_path:' not in text:
            continue
        # implement_setting_for_enum!(TypeName, Group, ..., [storage_key: "..",] toml_path: "..", ...)
        for m in enum_start.finditer(text):
            body = text[m.end():text.find(');', m.end())]
            toml = re.search(r'\btoml_path:\s*"([^"]+)"', body)
            if toml:
                key = re.search(r'\bstorage_key:\s*"([^"]+)"', body)
                mapping[key.group(1) if key else m.group(1)] = toml.group(1)
        for m in start.finditer(text):
            depth, i = 1, m.end()
            while depth and i < len(text):
                depth += {'{': 1, '}': -1}.get(text[i], 0)
                i += 1
            body = text[m.end():i]
            toml = re.search(r'\btoml_path:\s*"([^"]+)"', body)
            if not toml or 'type:' not in body:
                continue
            key = re.search(r'\bstorage_key:\s*"([^"]+)"', body)
            mapping[key.group(1) if key else m.group(1)] = toml.group(1)
json.dump(dict(sorted(mapping.items())), open(out, 'w'), indent=1)
print(f'{len(mapping)} settings -> {os.path.normpath(out)}')
