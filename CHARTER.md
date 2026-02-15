# Hopper Charter

## Purpose

Hopper exists to give individuals a simple, reliable way to distribute work to AI agents. It is a personal work queue — not a team collaboration tool, not a project management system, not a job scheduler. One person queues tasks; agents pick them up and do the work.

## Problem

AI coding agents (like Claude Code) are capable of completing well-defined tasks autonomously, but there is no lightweight mechanism to feed them work. Existing tools are either too heavy (issue trackers, CI pipelines) or too manual (copy-pasting prompts). There is a gap between "I know what needs to be done" and "an agent is doing it."

Hopper fills that gap.

## Principles

### Simple over sophisticated

Hopper stores data in a JSON file. It has zero runtime dependencies. It compiles to a single binary. There is no server, no database, no authentication layer. Complexity is the enemy of reliability for a personal tool.

### CLI-first

Every interaction happens through the command line. Agents consume `--json` output; humans read the default format. No web UI, no API server. The CLI is the interface for both roles.

### Clear ownership through claim tokens

When an agent claims a work item, it receives a unique token. Only that token can complete the item. This is not security — it is clarity. It prevents accidental completion of someone else's in-progress work and makes the handoff between claim and complete explicit.

### Agents are first-class users

Hopper is designed to be driven by AI agents as much as by humans. The `--json` flag, claim token protocol, and skill files all exist because agents need structured, predictable interfaces. The worker script and skill system are not afterthoughts — they are core to the tool's purpose.

### One item, one task

Each work item should be a discrete, self-contained unit of work. The coordinator breaks problems down; workers execute individual pieces. Hopper does not model dependencies, priorities, or task hierarchies. That decomposition is the coordinator's responsibility, not the queue's.

## Scope

Hopper **does**:

- Maintain an ordered queue of work items
- Provide a claim/complete lifecycle with token-based ownership
- Support requeue with reasons when work cannot be completed
- Generate short titles from task descriptions
- Produce both human-readable and machine-readable output
- Install skill files so AI agents know how to interact with it
- Compile to standalone binaries for macOS, Linux, and Windows

Hopper **does not**:

- Run as a service or daemon (the worker script is a convenience, not a server)
- Handle multi-user coordination or access control
- Model task dependencies, priorities, or scheduling
- Store results beyond a single text summary
- Provide notifications, webhooks, or integrations
- Manage agent lifecycles or health monitoring

## Success

Hopper is successful when a person can describe work, walk away, and return to find it completed — with a clear record of what was done. The tool should be invisible: fast to invoke, predictable in behavior, and trivial to understand.
