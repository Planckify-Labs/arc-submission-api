import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Query,
  Res,
  Request,
  ConflictException,
  BadRequestException,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { PurchasesService, PurchaseViewer } from "./purchases.service";
import { QueueService } from "../queue/queue.service";
import { CreatePurchaseDto, UpdatePurchaseDto } from "./dto/purchase.dto";
import { SearchPurchaseDto } from "./dto/search-purchase.dto";
import { CursorPaginationDto } from "../dto/common/pagination.dto";
import {
  ApiGetPurchase,
  ApiGetPurchases,
  ApiUpdatePurchaseStatus,
  ApiSearchPurchases,
  ApiGetUserPurchases,
  ApiGetTokenPurchases,
  ApiGetBlockchainPurchases,
  ApiGetPurchaseStatusByRefId,
  ApiGetQueueStats,
  ApiCreatePurchase,
} from "../decorators/swagger/purchase.decorators";
import { JwtAuthGuard } from "src/auth/guards/jwt-auth.guard";
import { RolesGuard } from "src/auth/guards/roles.guard";
import { Roles } from "src/decorators/roles.decorator";
import { UserRole } from "@generated/prisma";
import { addressesEqual } from "../auth/address-compare";

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("purchases")
@ApiTags("purchases")
export class PurchasesController {
  private readonly logger = new Logger(PurchasesController.name);
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly queueService: QueueService,
  ) {}

  @Post()
  @ApiCreatePurchase()
  async create(
    @Body() createPurchaseDto: CreatePurchaseDto,
    @Request() req: { user: { walletAddress?: string | null } },
    @Res() res: Response,
  ) {
    // The purchase is recorded against `walletAddress`, and its refId is
    // claimed before anything is checked on-chain. Without this, anyone who
    // read a booking's refId and wallet off the chain could claim it first,
    // pointed at the wrong contract, and leave the real payer's purchase
    // permanently "previously used".
    if (
      !addressesEqual(req.user?.walletAddress, createPurchaseDto.walletAddress)
    ) {
      throw new BadRequestException(
        "Wallet address does not belong to the authenticated user",
      );
    }

    // Never log the request headers or the whole DTO here: the headers carry
    // the caller's bearer token.
    const { refId } = createPurchaseDto;

    try {
      const existingRefIdStatus =
        await this.purchasesService.getReferenceIdWithPurchase(refId);

      if (existingRefIdStatus) {
        this.logger.log(
          `Idempotent request detected for refId: ${refId}. Status: ${existingRefIdStatus.status}`,
        );

        if (existingRefIdStatus.purchase) {
          const purchase = existingRefIdStatus.purchase;
          this.logger.log(
            `Returning existing purchase for refId: ${refId}, purchaseId: ${purchase.id}`,
          );

          return res.status(200).send({
            ...purchase,
            bookingId: existingRefIdStatus.bookingId,
          });
        }

        const errorMessage = `Reference ID ${refId} was previously used but the transaction failed. Please use a new reference ID.`;
        this.logger.warn(
          `Rejecting duplicate refId with failed status: ${refId}`,
        );
        throw new ConflictException(errorMessage);
      }
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        "Error during idempotency check, proceeding with caution:",
        error,
      );
    }

    try {
      const purchase = await this.purchasesService.create(createPurchaseDto);

      return res.status(201).send(purchase);
    } catch (error) {
      this.logger.error("error details:", error);
      this.logger.error("Error message:", error.message);
      this.logger.error("Error stack:", error.stack);

      throw error;
    }
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiGetPurchases()
  async findAll(
    @Query() paginationDto: CursorPaginationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.purchasesService.findAll(paginationDto);
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Get("search")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiSearchPurchases()
  async search(
    @Query() searchParams: SearchPurchaseDto,
    @Query() paginationDto: CursorPaginationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.purchasesService.search(
      searchParams,
      paginationDto,
    );
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Get("user/:userId")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiGetUserPurchases()
  async findByUser(
    @Param("userId") userId: string,
    @Query() paginationDto: CursorPaginationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.purchasesService.findByUser(
      userId,
      paginationDto,
    );
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Get("token/:tokenId")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiGetTokenPurchases()
  async findByToken(
    @Param("tokenId") tokenId: string,
    @Query() paginationDto: CursorPaginationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.purchasesService.findByToken(
      tokenId,
      paginationDto,
    );
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Get("blockchain/:blockchainId")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiGetBlockchainPurchases()
  async findByBlockchain(
    @Param("blockchainId") blockchainId: string,
    @Query() paginationDto: CursorPaginationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.purchasesService.findByBlockchain(
      blockchainId,
      paginationDto,
    );
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Get(":id")
  @ApiGetPurchase()
  findOne(
    @Request() req: { user: PurchaseViewer },
    @Param("id") id: string,
    @Query("vendorResponse") vendorResponse?: string,
  ) {
    const includeVendorResponse = vendorResponse === "true";
    return this.purchasesService.findOne(id, {
      vendorResponse: includeVendorResponse,
      viewer: req.user,
    });
  }

  @Put(":id/status")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiUpdatePurchaseStatus()
  updateStatus(
    @Param("id") id: string,
    @Body() updatePurchaseDto: UpdatePurchaseDto,
  ) {
    return this.purchasesService.updateStatus(id, updatePurchaseDto);
  }

  @Get("ref/:refId/status")
  @ApiGetPurchaseStatusByRefId()
  async getStatusByRefId(@Param("refId") refId: string) {
    const jobs = await this.queueService.getPurchaseJobsByRefId(refId);
    const referenceStatus =
      await this.purchasesService.getReferenceIdWithPurchase(refId);

    return {
      refId,
      referenceStatus: referenceStatus?.status || "not_found",
      purchase: referenceStatus?.purchase || null,
      jobs: {
        purchase: jobs.purchase
          ? {
              id: jobs.purchase.id,
              progress: jobs.purchase.progress,
              processedOn: jobs.purchase.processedOn,
              finishedOn: jobs.purchase.finishedOn,
              failedReason: jobs.purchase.failedReason,
            }
          : null,
        blockchain: jobs.blockchain
          ? {
              id: jobs.blockchain.id,
              progress: jobs.blockchain.progress,
              processedOn: jobs.blockchain.processedOn,
              finishedOn: jobs.blockchain.finishedOn,
              failedReason: jobs.blockchain.failedReason,
            }
          : null,
        vendor: jobs.vendor
          ? {
              id: jobs.vendor.id,
              progress: jobs.vendor.progress,
              processedOn: jobs.vendor.processedOn,
              finishedOn: jobs.vendor.finishedOn,
              failedReason: jobs.vendor.failedReason,
            }
          : null,
      },
    };
  }

  @Get("queue/stats")
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiGetQueueStats()
  async getQueueStats() {
    return await this.queueService.getQueueStats();
  }
}
