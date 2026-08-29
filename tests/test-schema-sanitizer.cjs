/**
 * Test Schema Sanitizer - Tests for schema transformation for Google API
 * 
 * Verifies that complex nested array schemas are properly converted to 
 * Google's protobuf format (uppercase type names) to fix issue #82:
 * "Proto field is not repeating, cannot start list"
 */

// Import the schema sanitizer functions
const path = require('path');

// Since we're in CommonJS and the module is ESM, we need to use dynamic import
async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           SCHEMA SANITIZER TEST SUITE                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const { sanitizeSchema, cleanSchema } = await import('../src/format/schema-sanitizer.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    function assertIncludes(actual, substring, message = '') {
        if (!JSON.stringify(actual).includes(substring)) {
            throw new Error(`${message}\nExpected to include: ${substring}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    // Test 1: Basic type conversion to uppercase
    test('Basic type conversion to uppercase', () => {
        const schema = { type: 'string', description: 'A test string' };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'STRING', 'Type should be uppercase STRING');
    });

    // Test 2: Object type conversion
    test('Object type conversion', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                age: { type: 'integer' }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'OBJECT', 'Object type should be uppercase');
        assertEqual(result.properties.name.type, 'STRING', 'Nested string type should be uppercase');
        assertEqual(result.properties.age.type, 'INTEGER', 'Nested integer type should be uppercase');
    });

    // Test 3: Array type conversion (the main bug fix)
    test('Array type conversion with items', () => {
        const schema = {
            type: 'array',
            items: {
                type: 'string'
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'ARRAY', 'Array type should be uppercase ARRAY');
        assertEqual(result.items.type, 'STRING', 'Items type should be uppercase STRING');
    });

    // Test 4: Nested array inside object (the actual bug scenario)
    test('Nested array inside object (Claude Code TodoWrite-style schema)', () => {
        const schema = {
            type: 'object',
            properties: {
                todos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'integer' },
                            title: { type: 'string' },
                            status: { type: 'string' }
                        }
                    }
                }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT', 'Root type should be OBJECT');
        assertEqual(result.properties.todos.type, 'ARRAY', 'Todos type should be ARRAY');
        assertEqual(result.properties.todos.items.type, 'OBJECT', 'Items type should be OBJECT');
        assertEqual(result.properties.todos.items.properties.id.type, 'INTEGER', 'id type should be INTEGER');
        assertEqual(result.properties.todos.items.properties.title.type, 'STRING', 'title type should be STRING');
    });

    // Test 5: Complex nested structure (simulating Claude Code tools)
    test('Complex nested structure with multiple array levels', () => {
        const schema = {
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            subtasks: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        step: { type: 'string' },
                                        completed: { type: 'boolean' }
                                    }
                                }
                            }
                        }
                    }
                },
                count: { type: 'number' }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.tasks.type, 'ARRAY');
        assertEqual(result.properties.tasks.items.type, 'OBJECT');
        assertEqual(result.properties.tasks.items.properties.subtasks.type, 'ARRAY');
        assertEqual(result.properties.tasks.items.properties.subtasks.items.type, 'OBJECT');
        assertEqual(result.properties.tasks.items.properties.subtasks.items.properties.completed.type, 'BOOLEAN');
        assertEqual(result.properties.count.type, 'NUMBER');
    });

    // Test 6: cleanSchema handles anyOf (when not stripped by sanitizeSchema)
    test('cleanSchema handles anyOf and converts types', () => {
        // Test cleanSchema directly with anyOf (bypassing sanitizeSchema)
        const schema = {
            type: 'object',
            properties: {
                value: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'object', properties: { name: { type: 'string' } } }
                    ]
                }
            }
        };
        const result = cleanSchema(schema);
        
        assertEqual(result.type, 'OBJECT');
        // anyOf gets flattened to best option (object type scores highest)
        assertEqual(result.properties.value.type, 'OBJECT');
    });

    // Test 7: Schema with type array (nullable)
    test('Schema with type array (nullable) gets flattened and converted', () => {
        const schema = {
            type: 'object',
            properties: {
                optional: {
                    type: ['string', 'null']
                }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.optional.type, 'STRING');
    });

    // Test 8: All primitive types
    test('All primitive types converted correctly', () => {
        const schema = {
            type: 'object',
            properties: {
                str: { type: 'string' },
                num: { type: 'number' },
                int: { type: 'integer' },
                bool: { type: 'boolean' },
                arr: { type: 'array', items: { type: 'string' } },
                obj: { type: 'object', properties: { x: { type: 'string' } } }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.properties.str.type, 'STRING');
        assertEqual(result.properties.num.type, 'NUMBER');
        assertEqual(result.properties.int.type, 'INTEGER');
        assertEqual(result.properties.bool.type, 'BOOLEAN');
        assertEqual(result.properties.arr.type, 'ARRAY');
        assertEqual(result.properties.obj.type, 'OBJECT');
    });

    // Test 9: Empty schema produces clean OBJECT without synthetic reason
    test('Empty schema produces clean OBJECT without synthetic reason', () => {
        const result = cleanSchema(sanitizeSchema(null));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties, {});
    });

    // Test 10: Real-world Claude Code tool schema simulation
    test('Real-world Claude Code ManageTodoList-style schema', () => {
        // Simulates the type of schema that caused issue #82
        const schema = {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['write', 'read']
                },
                todoList: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number' },
                            title: { type: 'string' },
                            status: {
                                type: 'string',
                                enum: ['not-started', 'in-progress', 'completed']
                            }
                        },
                        required: ['id', 'title', 'status']
                    }
                }
            },
            required: ['operation']
        };
        
        const result = cleanSchema(sanitizeSchema(schema));
        
        // Verify all types are uppercase
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.operation.type, 'STRING');
        assertEqual(result.properties.todoList.type, 'ARRAY');
        assertEqual(result.properties.todoList.items.type, 'OBJECT');
        assertEqual(result.properties.todoList.items.properties.id.type, 'NUMBER');
        assertEqual(result.properties.todoList.items.properties.title.type, 'STRING');
        assertEqual(result.properties.todoList.items.properties.status.type, 'STRING');
    });

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);
    
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
