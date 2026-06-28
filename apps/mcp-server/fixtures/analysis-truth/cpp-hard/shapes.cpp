namespace geo {
template<typename T>
class Shape {
public:
    virtual T area() = 0;
};
class Circle : public Shape<double> {
public:
    double area() { return scale() * r * r; }
    double scale() { return 3.14; }
    double r;
};
}
int main() { geo::Circle c; return (int)c.area(); }
