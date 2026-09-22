# Optional external-agent routing

Use a named external-agent Skill only when the user explicitly selects it or
when the surrounding project policy explicitly permits that route. Keep the
main Agent responsible for the goal, decomposition, final diff review, key
validation, integration, and final response.

Never send credentials, `.env` files, secrets, unrelated personal data, or
paths outside the current workspace. Do not commit, push, rewrite history, or
make production or paid-API side effects without explicit authorization.
