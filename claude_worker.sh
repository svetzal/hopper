#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="${AGENT_NAME:-claude-worker}"
HOPPER="${HOPPER:-hopper}"

# Claim the next queued work item
echo "Claiming next work item..."
CLAIM_JSON=$("$HOPPER" claim --agent "$AGENT_NAME" --json 2>&1) || {
  echo "No work available to claim."
  exit 0
}

TITLE=$(echo "$CLAIM_JSON" | jq -r '.title')
DESCRIPTION=$(echo "$CLAIM_JSON" | jq -r '.description')
TOKEN=$(echo "$CLAIM_JSON" | jq -r '.claimToken')
ITEM_ID=$(echo "$CLAIM_JSON" | jq -r '.id')
WORKING_DIR=$(echo "$CLAIM_JSON" | jq -r '.workingDir // empty')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Failed to parse claim token from hopper output."
  exit 1
fi

echo "Claimed: $TITLE"
echo "Token:   $TOKEN"
echo "ID:      $ITEM_ID"
if [[ -n "$WORKING_DIR" ]]; then
  echo "Dir:     $WORKING_DIR"
fi

# Change to working directory if specified
if [[ -n "$WORKING_DIR" ]]; then
  cd "$WORKING_DIR"
fi

# Run a Claude session to perform the work
PROMPT="You have been assigned the following task:

Title: $TITLE
Description: $DESCRIPTION

Please complete this task. When you are finished, provide a summary of what you did."

AUDIT_FILE="${ITEM_ID}-audit.jsonl"
RESULT_FILE="${ITEM_ID}-result.md"

echo ""
echo "Starting Claude session..."
echo "Audit log:   $AUDIT_FILE"
echo "Result file: $RESULT_FILE"

# Capture JSON audit stream to file
claude --print --verbose --dangerously-skip-permissions --output-format stream-json "$PROMPT" > "$AUDIT_FILE" 2>&1
CLAUDE_EXIT=$?

# Extract the final result text from the audit log
RESULT_TEXT=$(
  jq -r 'select(.type == "result") | .result // empty' "$AUDIT_FILE" 2>/dev/null \
    || jq -r 'select(.message?.content?) | .message.content[] | select(.type == "text") | .text' "$AUDIT_FILE" 2>/dev/null \
    || echo "(see audit log for details)"
)

# Save result to markdown file and display on terminal
echo "$RESULT_TEXT" > "$RESULT_FILE"
echo ""
echo "--- Claude Output ---"
echo "$RESULT_TEXT"
echo "---------------------"

if [[ $CLAUDE_EXIT -eq 0 ]]; then
  echo ""
  echo "Claude session completed. Marking work item as complete..."
  "$HOPPER" complete "$TOKEN" --agent "$AGENT_NAME" --result "$RESULT_TEXT"
else
  echo ""
  echo "Claude session failed. Requeuing work item..."
  "$HOPPER" requeue "$ITEM_ID" --reason "Claude session failed" --agent "$AGENT_NAME"
  exit 1
fi
