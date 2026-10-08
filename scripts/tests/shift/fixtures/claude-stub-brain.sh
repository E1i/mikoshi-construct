#!/bin/sh
first=$(head -n 1)
printf '%s\n' "$first" | sed -n 's/^[^`]*`\([^`]*\)`.*/\1/p' > "$STUB_OUT/started"
