# Normalize bd and mx JSON to the fields callers rely on (mission-xbdo.5),
# so parity diffs show contract breaks only.
# Usage: jq -S --arg mode rows|search|show|ready|memories -f normalize.jq

def secs: if type == "string" then sub("\\.[0-9]+"; "") | sub("Z?$"; "Z") else . end;

# list / search / children rows: sidebar, focus-land and memory-server fields.
def row: {
  id, title, status, priority, issue_type,
  description: (.description // ""),
  parent: (.parent // null),
  labels: ((.labels // []) | sort)
};

# show: the row plus detail fields and dependency targets. Comment authors
# are left out on purpose: bd's actor follows the cwd git config.
def showrow: row + {
  notes: (.notes // ""),
  design: (.design // ""),
  acceptance_criteria: (.acceptance_criteria // ""),
  close_reason: (.close_reason // null),
  created_at: (.created_at | secs),
  dependencies: ((.dependencies // []) | map({id, dependency_type}) | sort_by(.id, .dependency_type)),
  comments: ((.comments // []) | map({text, created_at: (.created_at | secs)}))
};

def arr: if type == "array" then . else [.] end;

if $mode == "rows" then (arr | map(row) | sort_by(.id))
# bd search rows carry no parent field; mx search rows do.
elif $mode == "search" then (arr | map(row | del(.parent)) | sort_by(.id))
elif $mode == "show" then (arr | map(showrow))
elif $mode == "ready" then (arr | map({id, title}) | sort_by(.id))
elif $mode == "memories" then del(.schema_version)
else . end
