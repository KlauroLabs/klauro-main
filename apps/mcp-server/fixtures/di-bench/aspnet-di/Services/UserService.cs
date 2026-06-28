namespace App.Services;

public interface IUserService
{
    string[] GetAll();
}

public class UserService : IUserService
{
    public string[] GetAll() => new[] { "alice", "bob" };
}
