namespace App.Services;

public interface IUserService
{
    User? Find(int id);
    void Add(User user);
}

public class UserService : IUserService
{
    public User? Find(int id) => null;
    public void Add(User user) { }
}
