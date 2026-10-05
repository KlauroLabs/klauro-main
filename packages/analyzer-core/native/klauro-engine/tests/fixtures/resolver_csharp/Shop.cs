using System.Collections.Generic;
using System.Linq;

namespace Shop
{
    public class Item
    {
        public int Total() { return 1; }
    }

    public class Other
    {
        public int Total() { return 2; }
    }

    public class Cart
    {
        private readonly List<Item> items = new List<Item>();

        public int Loop()
        {
            var sum = 0;
            foreach (var item in items)
            {
                sum += item.Total();
            }
            return sum;
        }

        public int Linq()
        {
            return items.Select(i => i.Total()).Sum();
        }

        public int Param(IEnumerable<Item> source)
        {
            return source.Sum(s => s.Total());
        }

        public int Names(List<string> names)
        {
            return names.Where(n => n.StartsWith("a")).Count();
        }
    }
}
