FROM mcr.microsoft.com/dotnet/sdk:8.0 as builder
WORKDIR /src
COPY . .
RUN dotnet publish apps/BillingWorker/BillingWorker.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/runtime:8.0
COPY --from=builder /out /app
WORKDIR /app
ENTRYPOINT ["dotnet", "BillingWorker.dll"]
