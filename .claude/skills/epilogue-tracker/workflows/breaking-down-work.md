<!-- et v0.8.7 -->
# Breaking Down Work

How to decompose features, bugs, and technical debt into the Screenplay Pattern. Every piece of work must tie back to a user goal.

## The Three Questions

Before starting any work, ask:

1. **Which user (actor) benefits from this?**
2. **What goal of theirs does this support?**
3. **What interaction describes how this helps them?**

If you cannot answer these three questions, either find the user need or seriously consider not doing the work.

## Step-by-Step Process

1. **Identify the user need** - Trace the request to a real person
2. **Create or find the goal** - Check existing goals before creating new ones
3. **Create the interaction** - Document how this work helps the user
4. **Do the work** - Implement with clear understanding of who benefits
5. **Validate** - Run `et validate --json` after changes

## Feature Requests

### Example: "Add dark mode to the app"

**Bad approach:** Jump straight to implementation as a task.

**Good approach:** Trace to the user.

Who wants this? Users who work in low-light environments.

```bash
# Check existing actors and goals
et list goals --actor end_user --format json

# Create or find the goal
et create goal --id "comfortable_viewing" \
  --description "Use the app comfortably in any lighting condition" \
  --actor "end_user" \
  --success-criteria "Theme adapts to environment; no eye strain in dark settings" --json

# Create the interaction
et create interaction --id "toggle_theme" \
  --description "Switch between light and dark themes based on preference" \
  --performed-by "end_user" \
  --goal "comfortable_viewing" --json
```

Now implement dark mode knowing exactly who it serves and what success looks like.

### Example: "Add export to CSV"

```bash
# Who exports? Admins generating reports.
et create goal --id "extract_data" \
  --description "Extract data from the system for external analysis" \
  --actor "admin" \
  --success-criteria "Data downloaded in usable format within seconds" --json

et create interaction --id "export_csv" \
  --description "Export filtered data as CSV for spreadsheet analysis" \
  --performed-by "admin" \
  --goal "extract_data" --json
```

## Bug Fixes

### Example: "Login fails intermittently"

**Bad approach:** Fix the bug without documenting user impact.

**Good approach:** Connect the fix to the affected goal.

```bash
# Check if there's an existing goal for reliable access
et list goals --format json --actor customer

# Create or find the goal
et create goal --id "reliable_access" \
  --description "Access my account reliably every time I log in" \
  --actor "customer" \
  --success-criteria "Login succeeds consistently; no intermittent failures" --json

# Document the fix as an interaction
et create interaction --id "reliable_login" \
  --description "Consistent login without intermittent failures" \
  --performed-by "customer" \
  --goal "reliable_access" --json
```

### Example: "Search returns wrong results"

```bash
# Find the affected goal
et show goal find_products --json

# Create the interaction for the fix
et create interaction --id "accurate_search" \
  --description "Search returns relevant results matching the query" \
  --performed-by "shopper" \
  --goal "find_products" --json
```

## Technical Debt

Technical debt requires the most careful reframing. The work seems internal, but it almost always serves a user need.

### Example: "Refactor the order processing module"

**Challenge the work:** Why refactor?

- Hard to maintain? Developer problem, not user problem.
- Hard to add payment methods? **Users want payment options.**
- Prone to bugs? **Users want reliable ordering.**

Multiple user goals may emerge from one refactoring task:

```bash
# Goal 1: Payment flexibility
et create goal --id "flexible_payment" \
  --description "Pay using my preferred payment method" \
  --actor "customer" \
  --success-criteria "Multiple payment options available at checkout" --json

et create interaction --id "payment_method_support" \
  --description "Support additional payment methods through modular processing" \
  --performed-by "customer" \
  --goals "flexible_payment" --json

# Goal 2: Order reliability
et create goal --id "reliable_ordering" \
  --description "Complete orders without errors or failures" \
  --actor "customer" \
  --success-criteria "Orders process correctly every time" --json

et create interaction --id "order_processing_reliability" \
  --description "Reliable order processing with consistent results" \
  --performed-by "customer" \
  --goal "reliable_ordering" --json
```

### Example: "Add database indexes"

```bash
# Why? Pages load slowly. Who cares? Customers browsing products.
et create interaction --id "fast_product_pages" \
  --description "Product pages load quickly with optimised data retrieval" \
  --performed-by "customer" \
  --goal "find_products" --json
```

## When Work Is Not Justified

Sometimes the Three Questions reveal that work lacks a clear user need.

**Internal tooling?** Your users might be developers or ops teams. They are valid actors:

```bash
et create actor --id "developer" --name "Developer" \
  --description "Engineer building and maintaining the system" --json
et create goal --id "efficient_development" \
  --description "Build and deploy features without friction" \
  --actor "developer" --json
```

**Pure tech debt with no user impact?** Consider waiting until it blocks user value. Not all cleanup is urgent.

**"Nice to have" with no user?** If no real person needs the outcome, strongly consider skipping it. The backlog is not a wish list.

## Building Journeys

When you have a complete user flow, document it as a journey. Journeys show the full path from need to satisfaction.

### Protagonist vs Step Performers

The journey's `actor` is the protagonist (who benefits). Individual steps can be performed by different actors.

```bash
# Customer support flow:
# - Customer submits ticket (performed by customer)
# - Agent investigates (performed by support_agent)
# - Agent provides solution (performed by support_agent)
# - Customer confirms resolution (performed by customer)
#
# Protagonist: customer (they benefit from the outcome)

et create journey --id "support_resolution" \
  --actor "customer" \
  --goal "get_issue_resolved" \
  --steps "submit_ticket,agent_investigates,provide_solution,confirm_resolution" \
  --narrative "Customer reports issue, support investigates, solution provided and confirmed" --json
```

### Multiple Journeys for One Goal

Different users may take different paths to the same goal:

```bash
# Returning customer: quick checkout
et create journey --id "quick_checkout" \
  --actor "customer" --goal "complete_purchase" \
  --steps "quick_buy,express_pay,receive_confirmation" \
  --narrative "Returning customer uses saved details for fast purchase" --json

# New customer: full checkout
et create journey --id "full_checkout" \
  --actor "customer" --goal "complete_purchase" \
  --steps "browse,add_to_cart,enter_details,pay,receive_confirmation" \
  --narrative "New customer goes through complete checkout flow" --json
```

## Closing and Reopening

### When Work Is Complete

```bash
# Mark individual interaction as done
et close interaction export_csv --json

# When the goal is fully achieved
et close goal extract_data --json
```

### Reviewing Closed Work

```bash
# See what has been accomplished
et list goals --format json --closed

# See everything with status indicators
et list --all --json
```

### Reopening

If a closed goal needs revisiting (new requirements, regression):

```bash
et reopen goal extract_data --json
```

## Validation Checkpoint

After any significant changes to the model, validate:

```bash
et validate --json
```

- **Fix errors immediately** - Broken references cause problems
- **Review warnings** - They often indicate work without clear user value
- **Run before commits** - Keep the model healthy
