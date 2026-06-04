#!/usr/bin/env python3
"""
Python AST Parser for Klauro Code Analysis
Extracts detailed information from Python source files using the ast module
"""

import ast
import sys
import json
import os
from typing import Dict, List, Any, Optional
import traceback


class PythonASTAnalyzer(ast.NodeVisitor):
    def __init__(self):
        self.imports = []
        self.functions = []
        self.classes = []
        self.decorators = []
        self.calls = []
        self.constants = []
        self.complexity = 0
        self.current_class = None
        self.current_function = None
        
    def visit_Import(self, node):
        for alias in node.names:
            self.imports.append({
                'module': alias.name,
                'alias': alias.asname,
                'line': node.lineno,
                'isFromImport': False,
                'names': []
            })
        self.generic_visit(node)
        
    def visit_ImportFrom(self, node):
        module = node.module or ''
        names = [alias.name for alias in node.names]
        self.imports.append({
            'module': module,
            'names': names,
            'line': node.lineno,
            'isFromImport': True,
            'level': node.level  # Relative import level
        })
        self.generic_visit(node)
        
    def visit_FunctionDef(self, node):
        self._visit_function(node, is_async=False)
        
    def visit_AsyncFunctionDef(self, node):
        self._visit_function(node, is_async=True)
        
    def _visit_function(self, node, is_async):
        # Extract function arguments
        args = []
        for arg in node.args.args:
            arg_info = {
                'name': arg.arg,
                'annotation': ast.unparse(arg.annotation) if arg.annotation else None
            }
            args.append(arg_info)
            
        # Extract decorators
        decorators = []
        for decorator in node.decorator_list:
            decorators.append(ast.unparse(decorator))
            
        # Extract return type
        returns = ast.unparse(node.returns) if node.returns else None
        
        # Get docstring
        docstring = ast.get_docstring(node)
        
        # Calculate complexity (simplified cyclomatic complexity)
        complexity = self._calculate_complexity(node)
        self.complexity += complexity
        
        # Extract function calls within this function
        function_calls = []
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    function_calls.append({
                        'name': child.func.id,
                        'line': child.lineno if hasattr(child, 'lineno') else 0
                    })
                elif isinstance(child.func, ast.Attribute):
                    function_calls.append({
                        'name': ast.unparse(child.func),
                        'line': child.lineno if hasattr(child, 'lineno') else 0
                    })
                    
        function_info = {
            'name': node.name,
            'lineno': node.lineno,
            'endLine': node.end_lineno if hasattr(node, 'end_lineno') else node.lineno,
            'args': args,
            'returns': returns,
            'decorators': decorators,
            'isAsync': is_async,
            'docstring': docstring,
            'complexity': complexity,
            'calls': function_calls
        }
        
        if self.current_class:
            # This is a method
            if 'methods' not in self.current_class:
                self.current_class['methods'] = []
            self.current_class['methods'].append(function_info)
        else:
            # This is a standalone function
            self.functions.append(function_info)
            
        # Visit children
        old_function = self.current_function
        self.current_function = function_info
        self.generic_visit(node)
        self.current_function = old_function
        
    def visit_ClassDef(self, node):
        # Extract base classes
        bases = []
        for base in node.bases:
            bases.append(ast.unparse(base))
            
        # Extract decorators
        decorators = []
        for decorator in node.decorator_list:
            decorators.append(ast.unparse(decorator))
            
        # Get docstring
        docstring = ast.get_docstring(node)
        
        class_info = {
            'name': node.name,
            'lineno': node.lineno,
            'endLine': node.end_lineno if hasattr(node, 'end_lineno') else node.lineno,
            'bases': bases,
            'decorators': decorators,
            'methods': [],
            'docstring': docstring
        }
        
        self.classes.append(class_info)
        
        # Visit methods
        old_class = self.current_class
        self.current_class = class_info
        self.generic_visit(node)
        self.current_class = old_class
        
    def visit_Call(self, node):
        # Track all function calls
        call_info = {
            'line': node.lineno if hasattr(node, 'lineno') else 0
        }
        
        if isinstance(node.func, ast.Name):
            call_info['name'] = node.func.id
        elif isinstance(node.func, ast.Attribute):
            call_info['name'] = ast.unparse(node.func)
        else:
            call_info['name'] = 'unknown'
            
        self.calls.append(call_info)
        self.generic_visit(node)
        
    def visit_Assign(self, node):
        # Track constants/configuration
        if isinstance(node.value, (ast.Constant, ast.List, ast.Dict)):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.constants.append({
                        'name': target.id,
                        'value': self._extract_value(node.value),
                        'line': node.lineno
                    })
        self.generic_visit(node)
        
    def _extract_value(self, node):
        """Extract simple values from AST nodes"""
        if isinstance(node, ast.Constant):
            return node.value
        elif isinstance(node, ast.List):
            return [self._extract_value(item) for item in node.elts]
        elif isinstance(node, ast.Dict):
            return {
                self._extract_value(k): self._extract_value(v)
                for k, v in zip(node.keys, node.values)
                if k is not None
            }
        return None
        
    def _calculate_complexity(self, node):
        """Calculate cyclomatic complexity"""
        complexity = 1
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For, ast.ExceptHandler)):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                complexity += len(child.values) - 1
        return complexity


def detect_frameworks(tree, imports):
    """Detect Python frameworks from imports and decorators"""
    frameworks = []
    
    # Django detection
    django_imports = ['django', 'django.conf', 'django.db', 'django.contrib', 'django.urls']
    if any(imp['module'].startswith(tuple(django_imports)) for imp in imports):
        frameworks.append('django')
        
    # Flask detection
    flask_imports = ['flask', 'flask_restful', 'flask_sqlalchemy']
    if any(imp['module'].startswith(tuple(flask_imports)) for imp in imports):
        frameworks.append('flask')
        
    # FastAPI detection
    if any(imp['module'].startswith('fastapi') for imp in imports):
        frameworks.append('fastapi')
        
    # Celery detection
    if any(imp['module'].startswith('celery') for imp in imports):
        frameworks.append('celery')
        
    # Pytest detection
    if any(imp['module'].startswith('pytest') for imp in imports):
        frameworks.append('pytest')
        
    # SQLAlchemy detection
    if any(imp['module'].startswith('sqlalchemy') for imp in imports):
        frameworks.append('sqlalchemy')
        
    # Pandas detection
    if any(imp['module'] in ['pandas', 'numpy', 'scipy'] for imp in imports):
        frameworks.append('data-science')
        
    # ML frameworks
    ml_frameworks = ['tensorflow', 'torch', 'sklearn', 'transformers', 'keras']
    for fw in ml_frameworks:
        if any(imp['module'].startswith(fw) for imp in imports):
            frameworks.append(fw)
            
    return frameworks


def extract_api_endpoints(tree, classes, functions):
    """Extract API endpoints from decorators"""
    endpoints = []
    
    # Check for Flask/FastAPI route decorators
    for func in functions:
        for decorator in func.get('decorators', []):
            if 'route(' in decorator or 'get(' in decorator or 'post(' in decorator:
                endpoints.append({
                    'function': func['name'],
                    'decorator': decorator,
                    'line': func['lineno']
                })
                
    # Check class methods for endpoints
    for cls in classes:
        for method in cls.get('methods', []):
            for decorator in method.get('decorators', []):
                if 'route(' in decorator or 'get(' in decorator or 'post(' in decorator:
                    endpoints.append({
                        'class': cls['name'],
                        'method': method['name'],
                        'decorator': decorator,
                        'line': method['lineno']
                    })
                    
    return endpoints


def analyze_file(filepath):
    """Analyze a Python file and return structured data"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
            
        tree = ast.parse(source, filepath)
        analyzer = PythonASTAnalyzer()
        analyzer.visit(tree)
        
        # Detect frameworks
        frameworks = detect_frameworks(tree, analyzer.imports)
        
        # Extract API endpoints
        endpoints = extract_api_endpoints(tree, analyzer.classes, analyzer.functions)
        
        return {
            'success': True,
            'filepath': filepath,
            'imports': analyzer.imports,
            'functions': analyzer.functions,
            'classes': analyzer.classes,
            'calls': analyzer.calls,
            'constants': analyzer.constants,
            'complexity': analyzer.complexity,
            'frameworks': frameworks,
            'endpoints': endpoints,
            'lines': len(source.splitlines())
        }
        
    except SyntaxError as e:
        return {
            'success': False,
            'filepath': filepath,
            'error': f'Syntax error: {str(e)}',
            'line': e.lineno
        }
    except Exception as e:
        return {
            'success': False,
            'filepath': filepath,
            'error': str(e),
            'traceback': traceback.format_exc()
        }


def main():
    """Main entry point for the script"""
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided'}))
        sys.exit(1)
        
    filepath = sys.argv[1]
    
    if not os.path.exists(filepath):
        print(json.dumps({'error': f'File not found: {filepath}'}))
        sys.exit(1)
        
    result = analyze_file(filepath)
    print(json.dumps(result, default=str))


if __name__ == '__main__':
    main()