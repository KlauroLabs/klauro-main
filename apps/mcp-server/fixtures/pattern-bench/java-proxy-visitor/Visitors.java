package com.example;

// Proxy controlling access to a real service.
interface DataSource { String load(); }

class RemoteDataSource implements DataSource {
    public String load() { return "rows"; }
}

class DataSourceProxy implements DataSource {
    private RemoteDataSource real;
    public String load() {
        if (real == null) real = new RemoteDataSource();
        return real.load();
    }
}

// Visitor over an AST-like structure.
interface AstVisitor { void visitLiteral(int v); void visitBinary(String op); }

class PrintVisitor implements AstVisitor {
    public void visitLiteral(int v) { /* print */ }
    public void visitBinary(String op) { /* print */ }
}
