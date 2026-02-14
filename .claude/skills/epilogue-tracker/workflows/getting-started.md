<!-- et v0.9.0 -->
# Getting Started with et

Step-by-step guide for bootstrapping Epilogue Tracker in a new project. Assumes `et` is installed and `.et_env` is configured per the Setup section in SKILL.md.

If there is no `.et_env` file in the project root, direct the user to:

1. **Go to** https://app.epiloguetracker.ca
2. **Log in** or **create an account** if they do not have one yet
3. **Find or create a project** in the web console that corresponds to this codebase
4. **Download the `.et_env` file** from the project settings page
5. **Place it in the project root directory** (the same directory where `et` commands will be run)

If skill files are not present in `.claude/skills/epilogue-tracker/`, run:

```bash
et init
```

This installs the skill files that teach AI coding assistants how to use the Screenplay Pattern and the `et` CLI. Run `et init` again after upgrading `et` to keep them current.

## Step 1: Verify Connection

```bash
et list --json
```

- **Empty array `[]`:** Good. Fresh project with no entities yet.
- **Array with data:** Project already has entities. Review them before adding more.
- **Error:** Check `.et_env` exists and you are running from the project root. See Setup in SKILL.md.

## Step 2: Identify Your Actors

Ask: **Who are the real people using this product?**

Create 2-4 distinct user roles. Focus on roles with genuinely different needs.

```bash
# Example: an e-commerce platform
et create actor --id "shopper" --name "Shopper" \
  --description "Customer browsing and purchasing products" --json

et create actor --id "seller" --name "Seller" \
  --description "Merchant listing products and fulfilling orders" --json

et create actor --id "support_agent" --name "Support Agent" \
  --description "Staff member resolving customer and seller issues" --json
```

**Avoid:** Internal team roles (developer, QA, project manager) unless they are genuinely your product's users.

**Exception:** Tools built for developers can have developer actors. A CI/CD tool's actor might be `developer` or `devops_engineer`.

## Step 3: Define User Goals

For each actor, ask: **What do they want to achieve?**

Write from the user's perspective. Include success criteria when possible.

```bash
# Shopper goals
et create goal --id "find_products" \
  --description "Find products that match my needs quickly" \
  --actor "shopper" \
  --success-criteria "Relevant products found within seconds" --json

et create goal --id "complete_purchase" \
  --description "Purchase products and receive confirmation" \
  --actor "shopper" \
  --success-criteria "Order placed, payment processed, confirmation received" --json

# Seller goals
et create goal --id "manage_inventory" \
  --description "Keep product listings accurate and up to date" \
  --actor "seller" \
  --success-criteria "All listings reflect current stock and pricing" --json
```

**Test your goals:** Can you complete the sentence "The user wants to..."? If not, it is probably a project goal, not a user goal.

## Step 4: Map Existing Work to Interactions

Review your current backlog or task list. For each item, apply the Three Questions:

1. Which actor benefits?
2. What goal does it support?
3. How does it help them?

```bash
# Task: "Add search filters" -> supports shopper finding products
et create interaction --id "filter_search_results" \
  --description "Filter search results by category, price, and rating" \
  --performed-by "shopper" \
  --goal "find_products" --json

# Task: "Implement checkout flow" -> supports shopper completing purchase
et create interaction --id "checkout_flow" \
  --description "Complete purchase with payment and shipping details" \
  --performed-by "shopper" \
  --goal "complete_purchase" --json

# Task: "Add inventory dashboard" -> supports seller managing inventory
et create interaction --id "inventory_dashboard" \
  --description "View and update product stock levels from a central dashboard" \
  --performed-by "seller" \
  --goal "manage_inventory" --json
```

**If a task does not map to any user goal**, either:
- Find the user need (trace technical work to the user it ultimately serves)
- Question whether the work is justified right now

## Step 5: Validate

Check that all relationships are correct:

```bash
et validate --json
```

**Fix errors** (broken references):
```bash
# Example: goal references non-existent actor
et update goal orphan_goal --actor correct_actor --json
```

**Review warnings** (potential issues):
```bash
# Example: interaction not linked to a goal
et update interaction unlinked_task --goal relevant_goal --json
# Or remove if not needed
et remove interaction unlinked_task --json
```

## Step 6: Ongoing Workflow

Once bootstrapped, follow this cycle for all new work:

1. **Before new work:** Check `et list --json`, find or create the goal
2. **Create interactions** for each piece of work tied to a goal
3. **Optionally create journeys** for complete user flows
4. **After completing work:** `et close interaction <id> --json` and `et close goal <id> --json` when achieved
5. **Periodically:** `et validate --json` to catch drift

### Reviewing Progress

```bash
# What's active?
et list --json

# What's been completed?
et list goals --format json --state created

# Everything at a glance
et list --all --json
```

### Creating Journeys (Optional)

When you have a complete user flow, document it as a journey:

```bash
et create journey --id "shopping_flow" \
  --actor "shopper" \
  --goal "complete_purchase" \
  --steps "filter_search_results,checkout_flow" \
  --narrative "Shopper finds products using filters, then completes purchase" --json
```

Journeys are optional but valuable for documenting how actors achieve their goals step by step.
