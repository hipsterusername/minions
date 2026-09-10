# JavaScript forth

Export class Forth from forth.mjs. new Forth() starts with an empty stack;
evaluate(program) consumes a space-separated string of signed decimal integers
and words, preserving the stack and definitions across calls. Read stack as an
array from bottom to top. Arithmetic pops right operand then left operand;
/ performs integer division (positive quotients discard the fraction).
DUP copies the top item; DROP removes it; SWAP exchanges the top two;
OVER copies the second item onto the top. Too few operands for any operation
must throw Error('Stack empty'), including the one-operand binary case.
Division by zero throws Error('Division by zero'). Unknown words throw
Error('Unknown command'). Definitions use `: name body ;`; numeric names,
including negative integers, throw Error('Invalid definition'). Missing `;`
throws Error('Unterminated definition'). Words and definitions are case-insensitive.
Definitions may override built-ins, operators, or prior definitions. Existing
compiled words retain earlier meanings when a dependency is redefined; a new
definition may use the previous definition of its own name. Definitions belong
to their Forth instance. Only this small language is required; no REPL is needed.

Use Node built-ins only; implement the named module. You may create local checks.
Do not use the internet or consult solutions outside this workspace.
For graph mode, use Codex with model gpt-5.6-sol for every child agent.

# Instructions

Implement an evaluator for a very simple subset of Forth.

[Forth][forth]
is a stack-based programming language.
Implement a very basic evaluator for a small subset of Forth.

Your evaluator has to support the following words:

- `+`, `-`, `*`, `/` (integer arithmetic)
- `DUP`, `DROP`, `SWAP`, `OVER` (stack manipulation)

Your evaluator also has to support defining new words using the customary syntax: `: word-name definition ;`.

To keep things simple the only data type you need to support is signed integers of at least 16 bits size.

You should use the following rules for the syntax: a number is a sequence of one or more (ASCII) digits, a word is a sequence of one or more letters, digits, symbols or punctuation that is not a number.
(Forth probably uses slightly different rules, but this is close enough.)

Words are case-insensitive.

[forth]: https://en.wikipedia.org/wiki/Forth_%28programming_language%29
